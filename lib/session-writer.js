/**
 * Writing one imported conversation into DSH session storage.
 *
 * The log is written through the mounted `sessionPersistence` service, so the
 * backend owns the directory layout, encoding, and durability rules, and is
 * then read back to prove the stored session really holds what was imported.
 * A failure never leaves a half-made session behind: whatever was written is
 * removed again, and the caller gets the cleanup outcome in the error details.
 *
 * @module dsh-share-link-import/lib/session-writer
 */

import { randomUUID } from 'node:crypto'
import { access, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'

import { CODES, ShareError } from './errors.js'
import { SESSION_FORMAT_VERSION } from './convert.js'

/** How often adding the session to the workspace is retried. */
const ATTACH_ATTEMPTS = 5

/** Delay between attach attempts, in milliseconds. */
const ATTACH_DELAY_MS = 200

/**
 * Write one session and make it visible under the chosen workspace.
 * @param {object} deps - mounted DSH services.
 * @param {object} deps.persistence - the `sessionPersistence` service.
 * @param {object|undefined} deps.projectionCache - the optional `sessionProjectionCache` service.
 * @param {object} deps.workspaces - the `workspaceRegistry` service.
 * @param {object} request - what to write.
 * @param {string} request.workspaceId - target workspace id.
 * @param {Array<object>} request.events - the contiguous seed log.
 * @param {string} request.title - accepted title, recorded only for the journal.
 * @param {number} request.createdAt - session creation time.
 * @param {() => string} [request.createId] - id source, overridable for tests.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<{sessionId: string, eventCount: number, workspacePath: string}>} the stored session.
 * @throws {ShareError} `WORKSPACE_UNKNOWN`, `WORKSPACE_NOT_WRITABLE`, `WRITE_FAILED`, or `VERIFY_FAILED`.
 */
export async function writeImportedSession(deps, request) {
  const { persistence, workspaces } = deps
  if (typeof persistence?.create !== 'function') {
    throw new ShareError(CODES.persistenceUnavailable, '当前 DSH 没有挂载会话存储服务，无法写入会话。')
  }
  if (typeof workspaces?.get !== 'function') {
    throw new ShareError(CODES.workspacesUnavailable, '当前 DSH 没有挂载工作区服务，无法选择目标工作区。')
  }

  const workspace = workspaces.get(request.workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new ShareError(CODES.workspaceUnknown, '目标工作区不存在，请重新选择一个工作区。')
  }
  const workspacePath = await assertWorkspaceDirectory(workspace.path)

  const createId = request.createId ?? randomUUID
  const sessionId = createId()
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: request.createdAt,
    cwd: workspacePath,
    isSeeded: false,
  }

  let handle
  try {
    handle = await persistence.create(header, { signal: request.signal })
  } catch (error) {
    throw new ShareError(CODES.writeFailed, `创建会话失败：${textOf(error)}`, { cause: error })
  }

  try {
    await handle.append(request.events)
    await handle.flush()
  } catch (error) {
    await releaseQuietly(handle)
    const cleanup = await cleanupFailedSession(persistence, sessionId)
    throw new ShareError(
      CODES.writeFailed,
      `写入会话失败：${textOf(error)}${cleanup === '' ? '' : `；${cleanup}`}`,
      { cause: error, details: { sessionId } },
    )
  }
  await releaseQuietly(handle)

  await verifyStoredSession(persistence, sessionId, request.events.length).catch(async (error) => {
    const cleanup = await cleanupFailedSession(persistence, sessionId)
    throw new ShareError(
      CODES.verifyFailed,
      `${textOf(error)}${cleanup === '' ? '' : `；${cleanup}`}`,
      { cause: error, details: { sessionId } },
    )
  })

  warmProjectionCache(deps.projectionCache, header, request.events)
  const attachFailure = await attachToWorkspace(workspace, sessionId)
  if (attachFailure !== null) {
    // The session is stored and readable; only its placement failed. Say so
    // instead of hiding a session the user can still open from the list.
    throw new ShareError(
      CODES.writeFailed,
      `会话 ${sessionId} 已写入，但没能加入工作区「${workspace.title}」：${attachFailure}。`
        + '请在会话列表中查找该会话，或删除后重试。',
      { details: { sessionId, stored: true } },
    )
  }

  return { sessionId, eventCount: request.events.length, workspacePath }
}

/**
 * Prove the workspace directory exists and is writable by this process.
 * @param {string} path - the workspace path.
 * @returns {Promise<string>} the canonical directory path.
 * @throws {ShareError} `WORKSPACE_NOT_WRITABLE` when the directory is gone or read-only.
 */
async function assertWorkspaceDirectory(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new ShareError(CODES.workspaceNotWritable, '目标工作区没有有效目录。')
  }
  let canonical
  try {
    canonical = await realpath(path)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('not a directory')
    await access(canonical, constants.W_OK)
  } catch (error) {
    throw new ShareError(
      CODES.workspaceNotWritable,
      `目标工作区目录不可用或无写入权限：${path}（${textOf(error)}）`,
      { cause: error },
    )
  }
  return canonical
}

/**
 * Read the stored log back and compare it with what was written.
 * @param {object} persistence - the session persistence service.
 * @param {string} sessionId - the stored session id.
 * @param {number} expectedCount - how many events were appended.
 * @returns {Promise<void>} resolution when the stored log matches.
 * @throws {Error} when the log is missing, short, or has a different tail.
 */
async function verifyStoredSession(persistence, sessionId, expectedCount) {
  const snapshot = await persistence.stat(sessionId)
  if (snapshot === undefined) throw new Error('会话写入后无法在存储中找到该会话')
  const reader = await persistence.open(sessionId, 'read')
  try {
    const { events } = await reader.read(0, expectedCount)
    if (events.length !== expectedCount) {
      throw new Error(`会话写入后只读到 ${events.length}/${expectedCount} 条事件`)
    }
    if (events[events.length - 1]?.type !== 'session/end-seed') {
      throw new Error('会话写入后末尾缺少 session/end-seed 标记')
    }
  } finally {
    await releaseQuietly(reader)
  }
}

/**
 * Warm the projection cache so the sidebar shows the title without a rebuild.
 * @param {object|undefined} projectionCache - the optional projection cache.
 * @param {object} header - the stored header.
 * @param {Array<object>} events - the written log.
 * @returns {void}
 */
function warmProjectionCache(projectionCache, header, events) {
  if (typeof projectionCache?.coldSnapshot !== 'function') return
  try {
    projectionCache.coldSnapshot(header, 0, events)
  } catch {
    // The cache is an optimization; a rebuild reproduces the same projections.
  }
}

/**
 * Add the stored session to its workspace, retrying while the index catches up.
 * @param {object} workspace - the workspace entity.
 * @param {string} sessionId - the stored session id.
 * @returns {Promise<string|null>} null on success, else the last failure text.
 */
async function attachToWorkspace(workspace, sessionId) {
  if (typeof workspace.attachSession !== 'function') return null
  let failure = null
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
    try {
      await workspace.attachSession(sessionId)
      return null
    } catch (error) {
      failure = textOf(error)
      await new Promise(resolve => setTimeout(resolve, ATTACH_DELAY_MS))
    }
  }
  return failure
}

/**
 * Release one handle without masking the failure that led here.
 * @param {{close?: () => Promise<void>}|undefined} handle - the handle.
 * @returns {Promise<void>} resolution once closed.
 */
async function releaseQuietly(handle) {
  try {
    await handle?.close?.()
  } catch {
    // Closing is best-effort; the session's durability was already attempted.
  }
}

/**
 * Remove a session that failed to write or verify.
 * @param {object} persistence - the session persistence service.
 * @param {string} sessionId - the session to remove.
 * @returns {Promise<string>} an empty string on success, else a sentence for the user.
 */
async function cleanupFailedSession(persistence, sessionId) {
  let location
  try {
    const snapshot = await persistence.stat(sessionId)
    location = snapshot?.location?.path
  } catch {
    location = undefined
  }
  if (typeof location !== 'string' || location.length === 0) {
    return '未能在存储中定位残留会话，请检查会话列表后手动删除'
  }
  try {
    await rm(location, { force: true })
    await rm(joinParent(location), { recursive: true, force: true })
    return '已清理未完成的会话'
  } catch (error) {
    return `残留会话文件需要手动删除：${location}（${textOf(error)}）`
  }
}

/**
 * The directory holding one session artifact.
 * @param {string} path - the artifact path.
 * @returns {string} its parent directory.
 */
function joinParent(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index <= 0 ? path : path.slice(0, index)
}

/**
 * Render an unknown thrown value as text.
 * @param {unknown} error - the thrown value.
 * @returns {string} its message.
 */
function textOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Count how many events one round contributes, for size reporting.
 * @param {number} rounds - number of complete rounds.
 * @returns {number} the event count of a log with that many rounds.
 */
export function eventCountFor(rounds) {
  // title + (six events per round + one system head) + end-seed
  return 1 + rounds * 6 + 1 + 1
}
