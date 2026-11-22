/**
 * Reading one public share through DeepSeek's anonymous content endpoint.
 *
 * The request carries no cookie, token, or account identity: the endpoint is
 * the same one a logged-out browser uses. Redirects are refused, the body is
 * size-capped, and every transport outcome is mapped onto the shared error
 * vocabulary so the panel can say what actually happened.
 *
 * @module dsh-share-link-import/lib/share-api
 */

import { CODES, ShareError } from './errors.js'

/** The single host this module ever contacts. */
const SHARE_ORIGIN = 'https://chat.deepseek.com'

/** Largest body this plugin is willing to read, in bytes. */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** Timeout of one fetch, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Fetch and decode one share's JSON document.
 * @param {string} shareId - a validated share id.
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options] - timeout and fetch override.
 * @returns {Promise<unknown>} the decoded JSON document.
 * @throws {ShareError} for every network, HTTP, size, or JSON failure.
 */
export async function fetchShareContent(shareId, options = {}) {
  const url = `${SHARE_ORIGIN}/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`
  const text = await fetchText(url, {
    accept: 'application/json',
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  try {
    return JSON.parse(text)
  } catch {
    throw new ShareError(
      CODES.malformed,
      '分享接口没有返回 JSON，分享可能已失效或需要登录。',
    )
  }
}

/**
 * GET one absolute URL as text, enforcing the redirect, size, and status rules.
 * @param {string} url - absolute URL built from a validated share id.
 * @param {{accept: string, timeoutMs?: number, fetchImpl?: typeof fetch}} options - request settings.
 * @returns {Promise<string>} the response body.
 * @throws {ShareError} on network failure, refusal, timeout, oversize body, or non-2xx status.
 */
async function fetchText(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ShareError(CODES.fetchFailed, '当前环境没有可用的 fetch，无法读取分享内容。')
  }
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs)

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      signal,
      redirect: 'error',
      headers: { Accept: options.accept, 'User-Agent': 'dsh-share-link-import' },
    })
  } catch (error) {
    throw transportError(error, timeoutMs)
  }

  if (!response.ok) throw statusError(response.status)

  let text
  try {
    text = await response.text()
  } catch (error) {
    throw transportError(error, timeoutMs)
  }
  if (text.length > MAX_CONTENT_BYTES) {
    throw new ShareError(CODES.fetchFailed, '分享内容超过 8 MiB，已拒绝读取。')
  }
  if (text.trim().length === 0) {
    throw new ShareError(CODES.malformed, '分享接口返回了空内容，分享可能已失效。')
  }
  return text
}

/**
 * Map an HTTP status onto a user-facing failure.
 * @param {number} status - the response status.
 * @returns {ShareError} the matching failure.
 */
function statusError(status) {
  if (status === 404) {
    return new ShareError(CODES.notFound, '分享不存在或已被删除（HTTP 404）。')
  }
  if (status === 401 || status === 403) {
    return new ShareError(
      CODES.forbidden,
      `分享未公开或已过期，DeepSeek 拒绝匿名访问（HTTP ${status}）。`,
    )
  }
  if (status >= 500) {
    return new ShareError(CODES.serverError, `DeepSeek 分享服务暂时不可用（HTTP ${status}），请稍后重试。`)
  }
  return new ShareError(CODES.fetchFailed, `分享接口返回 HTTP ${status}。`)
}

/**
 * Translate a fetch rejection into a failure that names the likely cause.
 * @param {unknown} error - the thrown value.
 * @param {number} timeoutMs - the timeout that was in force.
 * @returns {ShareError} the normalized failure.
 */
function transportError(error, timeoutMs) {
  if (error instanceof ShareError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ShareError(
      CODES.fetchFailed,
      `读取分享内容超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络后重试。`,
      { cause: error },
    )
  }
  const text = error instanceof Error ? error.message : String(error)
  return new ShareError(CODES.fetchFailed, `无法连接 DeepSeek 分享接口：${text}`, { cause: error })
}
