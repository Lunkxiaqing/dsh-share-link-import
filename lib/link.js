/**
 * DeepSeek share-link parsing.
 *
 * Accepts a full share URL (with or without a trailing slash, query or hash)
 * and a bare share id, because users paste either. Anything else is rejected
 * with a message that says what the expected shape is.
 *
 * @module dsh-share-link-import/lib/link
 */

import { CODES, ShareError } from './errors.js'

/** The only host a share link may point at. */
export const SHARE_HOST = 'chat.deepseek.com'

/** Share ids are URL-safe tokens; the exact length has varied between releases. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

/** `https://chat.deepseek.com/share/<id>` with an optional trailing slash. */
const SHARE_PATH_PATTERN = /^\/share\/([A-Za-z0-9_-]{6,64})\/?$/

/**
 * Extract the share id from pasted text.
 *
 * Accepted forms:
 * - `https://chat.deepseek.com/share/<id>`
 * - `https://chat.deepseek.com/share/<id>/?from=...` (query/hash ignored)
 * - `https://chat.deepseek.com/share?share_id=<id>`
 * - a bare `<id>`
 *
 * @param {unknown} input - whatever the user pasted.
 * @returns {{shareId: string, url: string}} the id and its canonical share page.
 * @throws {ShareError} `SHARE_LINK_INVALID` with a Chinese explanation.
 */
export function parseShareLink(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) {
    throw new ShareError(CODES.linkInvalid, '分享链接为空，请粘贴形如 https://chat.deepseek.com/share/<id> 的链接。')
  }

  if (SHARE_ID_PATTERN.test(text)) return result(text)

  let url
  try {
    url = new URL(text)
  } catch {
    throw new ShareError(
      CODES.linkInvalid,
      '无法识别该链接，请粘贴形如 https://chat.deepseek.com/share/<id> 的 DeepSeek 分享链接。',
    )
  }
  if (url.protocol !== 'https:') {
    throw new ShareError(CODES.linkInvalid, '分享链接必须使用 https。')
  }
  if (url.hostname.toLowerCase() !== SHARE_HOST) {
    throw new ShareError(
      CODES.linkInvalid,
      `只支持 ${SHARE_HOST} 的分享链接，当前链接的域名是 ${url.hostname}。`,
    )
  }

  const fromQuery = url.searchParams.get('share_id')
  if (fromQuery !== null && SHARE_ID_PATTERN.test(fromQuery)) return result(fromQuery)

  const fromPath = SHARE_PATH_PATTERN.exec(url.pathname)
  if (fromPath !== null) return result(fromPath[1])

  throw new ShareError(
    CODES.linkInvalid,
    '链接里没有找到分享 ID，正确格式是 https://chat.deepseek.com/share/<id>。',
  )
}

/**
 * The canonical page URL of one share id.
 * @param {string} shareId - a validated share id.
 * @returns {string} the page a user would open in a browser.
 */
export function sharePageUrl(shareId) {
  return `https://${SHARE_HOST}/share/${shareId}`
}

/**
 * The public JSON endpoint of one share.
 * @param {string} shareId - a validated share id.
 * @returns {string} the absolute content URL.
 */
export function shareContentUrl(shareId) {
  return `https://${SHARE_HOST}/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`
}

/**
 * Pair a validated id with its canonical page.
 * @param {string} shareId - a validated share id.
 * @returns {{shareId: string, url: string}} the parse result.
 */
function result(shareId) {
  return { shareId, url: sharePageUrl(shareId) }
}
