/**
 * Failure vocabulary of the share-link importer.
 *
 * Every failure path raises a {@link ShareError} carrying a stable machine code
 * and a ready-to-show Chinese message, so neither the host routes nor the
 * browser panel ever have to invent user-facing text for a failed import.
 *
 * @module dsh-share-link-import/lib/errors
 */

/** Machine codes returned to the client. */
export const CODES = Object.freeze({
  /** The pasted text is not a DeepSeek share link (or has no share id). */
  linkInvalid: 'SHARE_LINK_INVALID',
  /** The share is deleted, expired, made private, or the id is wrong. */
  notFound: 'SHARE_NOT_FOUND',
  /** The public endpoint requires a session the plugin does not have (403). */
  forbidden: 'SHARE_FORBIDDEN',
  /** DeepSeek answered 5xx. */
  serverError: 'SHARE_SERVER_ERROR',
  /** Network failure, timeout, or an oversized body. */
  fetchFailed: 'SHARE_FETCH_FAILED',
  /** The endpoint answered, but not with a readable share document. */
  malformed: 'SHARE_MALFORMED',
  /** The share carries no complete question/answer round. */
  empty: 'SHARE_EMPTY',
  /** This share id was already imported into this DSH home. */
  alreadyImported: 'ALREADY_IMPORTED',
  /** The request names no workspace. */
  workspaceRequired: 'WORKSPACE_REQUIRED',
  /** The workspace id is not registered. */
  workspaceUnknown: 'WORKSPACE_UNKNOWN',
  /** The registry has no readable workspace list. */
  workspacesUnavailable: 'WORKSPACES_UNAVAILABLE',
  /** The target workspace directory is gone or not writable. */
  workspaceNotWritable: 'WORKSPACE_NOT_WRITABLE',
  /** DSH session persistence is not mounted in this profile. */
  persistenceUnavailable: 'PERSISTENCE_UNAVAILABLE',
  /** Writing the session log failed. */
  writeFailed: 'WRITE_FAILED',
  /** The session log was written but could not be read back. */
  verifyFailed: 'VERIFY_FAILED',
  /** Anything unexpected. */
  internal: 'INTERNAL',
})

/**
 * A failed import step with a stable code and a Chinese message for the user.
 */
export class ShareError extends Error {
  /**
   * @param {string} code - one of {@link CODES}.
   * @param {string} message - Chinese text shown as-is in the panel.
   * @param {{cause?: unknown, details?: Record<string, unknown>}} [options] - optional cause and detail payload.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ShareError'
    this.code = code
    this.details = options.details ?? {}
  }
}

/**
 * Narrow an unknown thrown value into a {@link ShareError}, preserving an
 * already-typed failure and reporting anything else as `INTERNAL`.
 * @param {unknown} error - the thrown value.
 * @param {string} fallbackMessage - Chinese text for an unexpected failure.
 * @returns {ShareError} the normalized failure.
 */
export function asShareError(error, fallbackMessage) {
  if (error instanceof ShareError) return error
  const text = error instanceof Error ? error.message : String(error)
  return new ShareError(CODES.internal, `${fallbackMessage}：${text}`, { cause: error })
}

/**
 * Build the wire payload of one failure.
 * @param {ShareError} error - the normalized failure.
 * @returns {{ok: false, code: string, message: string, details: Record<string, unknown>}} the response body.
 */
export function failurePayload(error) {
  return { ok: false, code: error.code, message: error.message, details: error.details }
}
