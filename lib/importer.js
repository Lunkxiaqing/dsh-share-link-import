/**
 * The importer's entry points, independent of transport.
 *
 * Preview and import share one reading path, so what the panel promises is
 * exactly what the import writes. Deduplication happens here, against the
 * journal, and a re-import is refused unless the caller explicitly forces it.
 *
 * @module dsh-share-link-import/lib/importer
 */

import { CODES, ShareError } from './errors.js'
import { parseShareLink } from './link.js'
import { fetchShareContent } from './share-api.js'
import { buildRounds, importTitle, readShareDocument } from './messages.js'
import { auditEvents, buildSessionEvents } from './convert.js'
import { findImport, recordImport } from './dedup.js'
import { writeImportedSession } from './session-writer.js'

/**
 * Read, validate, and convert one share link without writing anything.
 * @param {object} deps - dependencies.
 * @param {object} deps.workspaces - the workspace registry, read to name the target.
 * @param {string} deps.journalFile - the dedup journal path.
 * @param {(shareId: string, options?: object) => Promise<unknown>} [deps.fetchContent] - share reader, overridable for tests.
 * @param {() => string} [deps.createId] - id source for message ids.
 * @param {number} [deps.now] - clock, overridable for tests.
 * @param {object} request - the preview request.
 * @param {string} request.link - what the user pasted.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} the preview and the writable conversion.
 */
export async function prepareImport(deps, request) {
  const { shareId, url } = parseShareLink(request.link)
  const fetchContent = deps.fetchContent ?? fetchShareContent
  const payload = await fetchContent(shareId, { signal: request.signal })
  const { title: shareTitle, messages } = readShareDocument(payload)
  const { rounds, droppedUnanswered, droppedOrphans } = buildRounds(messages)
  if (rounds.length === 0) {
    throw new ShareError(
      CODES.empty,
      messages.length === 0
        ? '这个分享里没有任何消息。'
        : '这个分享里没有问答完整的轮次（提问都没有回答）。',
    )
  }

  const title = importTitle(shareTitle, rounds[0].question)
  const createId = deps.createId ?? defaultId
  const { events, createdAt } = buildSessionEvents({
    rounds,
    title,
    createId,
    now: deps.now,
  })
  const audit = auditEvents(events)
  if (!audit.ok) {
    throw new ShareError(CODES.internal, `生成的事件序列不合法：${audit.problems[0]}`)
  }

  const previous = await findImport(deps.journalFile, shareId)
  return {
    shareId,
    url,
    title,
    rounds: rounds.length,
    messages: messages.length,
    droppedUnanswered,
    droppedOrphans,
    createdAt,
    events,
    alreadyImported: previous ?? null,
  }
}

/**
 * Preview one share link for the panel.
 * @param {object} deps - dependencies, as {@link prepareImport}.
 * @param {{link: string, signal?: AbortSignal}} request - the preview request.
 * @returns {Promise<object>} a JSON-safe summary; the event log is not exposed.
 */
export async function previewShareLink(deps, request) {
  const prepared = await prepareImport(deps, request)
  return {
    ok: true,
    shareId: prepared.shareId,
    url: prepared.url,
    title: prepared.title,
    rounds: prepared.rounds,
    messages: prepared.messages,
    droppedUnanswered: prepared.droppedUnanswered,
    alreadyImported: prepared.alreadyImported,
    eventCount: prepared.events.length,
  }
}

/**
 * Import one share link into the chosen workspace.
 * @param {object} deps - dependencies, as {@link prepareImport}, plus the write services.
 * @param {object} deps.persistence - the session persistence service.
 * @param {object|undefined} deps.projectionCache - the optional projection cache.
 * @param {object} request - the import request.
 * @param {string} request.link - what the user pasted.
 * @param {string} request.workspaceId - target workspace id.
 * @param {boolean} [request.force] - import again even if this share was imported before.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} the new session id and what it holds.
 */
export async function importShareLink(deps, request) {
  if (typeof request.workspaceId !== 'string' || request.workspaceId.length === 0) {
    throw new ShareError(CODES.workspaceRequired, '请选择要导入到哪个工作区。')
  }
  if (typeof deps.workspaces?.get !== 'function') {
    throw new ShareError(CODES.workspacesUnavailable, '当前 DSH 没有挂载工作区服务，无法选择目标工作区。')
  }

  const prepared = await prepareImport(deps, request)
  if (prepared.alreadyImported !== null && request.force !== true) {
    throw new ShareError(
      CODES.alreadyImported,
      `这个分享已经导入过：会话「${prepared.alreadyImported.title}」`
        + `（${prepared.alreadyImported.sessionId}）。如需再导入一份，请使用「仍然导入」。`,
      { details: { sessionId: prepared.alreadyImported.sessionId, title: prepared.alreadyImported.title } },
    )
  }

  const written = await writeImportedSession(
    { persistence: deps.persistence, projectionCache: deps.projectionCache, workspaces: deps.workspaces },
    {
      workspaceId: request.workspaceId,
      events: prepared.events,
      title: prepared.title,
      createdAt: prepared.createdAt,
      signal: request.signal,
    },
  )

  try {
    await recordImport(deps.journalFile, prepared.shareId, {
      sessionId: written.sessionId,
      title: prepared.title,
      importedAt: Date.now(),
    })
  } catch (error) {
    // The session exists; only the dedup record is missing. Report it instead
    // of pretending the import failed.
    throw new ShareError(
      CODES.writeFailed,
      `会话 ${written.sessionId} 已写入，但记录去重信息失败：${textOf(error)}。`
        + '下次导入同一链接时不会被拦下。',
      { cause: error, details: { sessionId: written.sessionId, stored: true } },
    )
  }

  return {
    ok: true,
    sessionId: written.sessionId,
    title: prepared.title,
    rounds: prepared.rounds,
    eventCount: written.eventCount,
    droppedUnanswered: prepared.droppedUnanswered,
    workspacePath: written.workspacePath,
  }
}

/**
 * Mint a message id.
 * @returns {string} a random id.
 */
function defaultId() {
  return globalThis.crypto.randomUUID()
}

/**
 * Render an unknown thrown value as text.
 * @param {unknown} error - the thrown value.
 * @returns {string} its message.
 */
function textOf(error) {
  return error instanceof Error ? error.message : String(error)
}
