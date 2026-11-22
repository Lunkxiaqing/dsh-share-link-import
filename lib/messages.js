/**
 * Reading a DeepSeek share document into question/answer rounds.
 *
 * The public endpoint wraps the conversation as
 * `data.biz_data.messages[]`, and older deployments have answered with the
 * conversation one level higher; both shapes are read. Inside one message the
 * conversation text lives in `fragments[]`, whose `type` is the role evidence:
 * `REQUEST` is the human question, `RESPONSE` is the assistant answer. A
 * message-level `role` is used when it is present, and ignored when it is not.
 *
 * @module dsh-share-link-import/lib/messages
 */

import { CODES, ShareError } from './errors.js'

/** Largest UTF-8 size of a derived title, matching the session-title limit of shipped profiles. */
export const MAX_TITLE_BYTES = 80

/**
 * Titles a share carries when the conversation itself has no title. They are
 * not information, so the first question is used instead.
 */
const PLACEHOLDER_TITLES = new Set([
  'shared conversation',
  'shared chat',
  '分享的对话',
  '来自分享的对话',
  '分享对话',
])

/**
 * Read the conversation out of one share response document.
 * @param {unknown} payload - the decoded JSON answer of the share endpoint.
 * @returns {{title: string, messages: Array<{role: 'user'|'assistant', text: string, time?: number}>}} the reading.
 * @throws {ShareError} when the document is unreadable or the share is gone.
 */
export function readShareDocument(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new ShareError(CODES.malformed, '分享内容不是有效的 JSON，分享可能已失效。')
  }
  const document = /** @type {Record<string, any>} */ (payload)

  if (document.code !== undefined && Number(document.code) !== 0) {
    throw new ShareError(CODES.notFound, '分享不存在或已被删除。')
  }
  const data = isRecord(document.data) ? document.data : document
  if (data.biz_code !== undefined && Number(data.biz_code) !== 0) {
    const detail = typeof data.biz_msg === 'string' && data.biz_msg.length > 0 ? `（${data.biz_msg}）` : ''
    throw new ShareError(CODES.notFound, `分享不存在或已被删除${detail}。`)
  }

  const biz = isRecord(data.biz_data) ? data.biz_data : data
  const rawMessages = Array.isArray(biz.messages) ? biz.messages : null
  if (rawMessages === null) {
    throw new ShareError(CODES.malformed, '分享内容里没有消息列表，页面结构可能已变化。')
  }

  const title = typeof biz.title === 'string' ? biz.title.trim() : ''
  const messages = []
  for (const raw of rawMessages) {
    const message = readMessage(raw)
    if (message !== null) messages.push(message)
  }
  return { title, messages }
}

/**
 * Build importable rounds from normalized messages, in their original order.
 *
 * A question without a following answer is dropped (including the trailing
 * one), so no incomplete turn is ever written. A stray answer, or a second
 * question asked before the first was answered, is dropped as well.
 *
 * @param {Array<{role: 'user'|'assistant', text: string, time?: number}>} messages - normalized messages.
 * @returns {{rounds: Array<{question: string, answer: string, questionTime?: number, answerTime?: number}>, droppedUnanswered: number, droppedOrphans: number}} the rounds and what was left out.
 */
export function buildRounds(messages) {
  const rounds = []
  let droppedUnanswered = 0
  let droppedOrphans = 0
  let pending = null
  for (const message of messages) {
    if (message.role === 'user') {
      if (pending !== null) droppedUnanswered += 1
      pending = message
      continue
    }
    if (pending === null) {
      droppedOrphans += 1
      continue
    }
    rounds.push({
      question: pending.text,
      answer: message.text,
      ...(pending.time === undefined ? {} : { questionTime: pending.time }),
      ...(message.time === undefined ? {} : { answerTime: message.time }),
    })
    pending = null
  }
  if (pending !== null) droppedUnanswered += 1
  return { rounds, droppedUnanswered, droppedOrphans }
}

/**
 * The title of an import: the share's own title, else the first question,
 * truncated on a UTF-8 boundary.
 * @param {string} shareTitle - the title the share carries, possibly empty.
 * @param {string} firstQuestion - the first question, used as the fallback.
 * @returns {string} the title to store, never longer than {@link MAX_TITLE_BYTES} bytes.
 */
export function importTitle(shareTitle, firstQuestion) {
  const normalized = collapseWhitespace(shareTitle)
  if (normalized.length > 0 && !PLACEHOLDER_TITLES.has(normalized.toLowerCase())) {
    return truncateUtf8(normalized, MAX_TITLE_BYTES)
  }
  return truncateUtf8(collapseWhitespace(firstQuestion), MAX_TITLE_BYTES)
}

/**
 * Collapse runs of whitespace into one space.
 * @param {string} text - raw text.
 * @returns {string} the collapsed text.
 */
function collapseWhitespace(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param {string} text - text to truncate.
 * @param {number} maxBytes - byte budget.
 * @returns {string} the truncated text.
 */
export function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let result = ''
  let used = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

/**
 * Read one message into a role and its text.
 * @param {unknown} raw - one entry of the share message list.
 * @returns {{role: 'user'|'assistant', text: string, time?: number}|null} the message, or null when it carries no readable text.
 */
function readMessage(raw) {
  if (!isRecord(raw)) return null
  const fragments = Array.isArray(raw.fragments) ? raw.fragments : []
  const asked = fragmentTexts(fragments, 'REQUEST')
  const answered = fragmentTexts(fragments, 'RESPONSE')

  const declared = normalizeRole(raw.role)
  const role = declared ?? (asked.length > 0 || answered.length === 0 ? 'user' : 'assistant')
  const own = role === 'user' ? asked : answered
  const text = (own.length > 0 ? own : typeof raw.content === 'string' ? [raw.content] : [])
    .join('\n')
    .trim()
  if (text.length === 0) return null
  // An answer the server never finished is not an answer: leaving it out
  // makes its question unanswered, and the round is dropped as incomplete.
  if (role === 'assistant' && isUnfinished(raw)) return null

  const time = messageTime(raw)
  return { role, text, ...(time === undefined ? {} : { time }) }
}

/**
 * Texts of one fragment type, in order.
 * @param {unknown[]} fragments - the message fragments.
 * @param {'REQUEST'|'RESPONSE'} type - the fragment type to keep.
 * @returns {string[]} non-empty contents.
 */
function fragmentTexts(fragments, type) {
  const texts = []
  for (const fragment of fragments) {
    if (!isRecord(fragment)) continue
    if (String(fragment.type ?? '').toUpperCase() !== type) continue
    if (typeof fragment.content !== 'string') continue
    const text = fragment.content.trim()
    if (text.length > 0) texts.push(text)
  }
  return texts
}

/**
 * Whether the share marks one message as never finished.
 * @param {Record<string, any>} message - one share message.
 * @returns {boolean} true when the answer is incomplete or still running.
 */
function isUnfinished(message) {
  if (message.incomplete_message !== null && message.incomplete_message !== undefined) return true
  return typeof message.status === 'string' && message.status.length > 0 && message.status !== 'FINISHED'
}

/**
 * Normalize a declared message role.
 * @param {unknown} value - the raw `role` field.
 * @returns {'user'|'assistant'|null} the role, or null when absent or unknown.
 */
function normalizeRole(value) {
  if (typeof value !== 'string') return null
  const role = value.toLowerCase()
  if (role === 'user' || role === 'request' || role === 'human') return 'user'
  if (role === 'assistant' || role === 'response' || role === 'ai') return 'assistant'
  return null
}

/**
 * Read a message timestamp as epoch milliseconds.
 * @param {Record<string, any>} message - one share message.
 * @returns {number|undefined} the timestamp, when the document carries a usable one.
 */
function messageTime(message) {
  for (const field of ['inserted_at', 'created_at', 'timestamp', 'time']) {
    const value = message[field]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * Whether a value is a plain object.
 * @param {unknown} value - any value.
 * @returns {boolean} true for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
