/**
 * Prompt placement of an imported seed log.
 *
 * An import writes an empty `system/message` as surface node 0 (the slot DSH
 * reserves for the system prompt) and appends the conversation after it. On a
 * resumed session DSH only *normalizes* that empty node — replacing it with the
 * real prompt — when a request series starts. The first request of a resumed
 * session does not start one, so the prompt is instead appended at the tail:
 * the model receives 100+ imported rounds before its own system prompt, and the
 * imported history leads the request instead of the prompt.
 *
 * That layout has a second cost. Should a later request start a series (for
 * example when the declared tool list changes), the projection normalizes the
 * whole prompt back onto node 0 and empties the tail node, which moves the
 * first message of the request and invalidates every cached prefix of the
 * conversation at once.
 *
 * This module decides, once per imported session, to ask the Agent loop for a
 * series start at the first request, so the prompt lands on node 0 exactly the
 * way a live session's prompt does.
 *
 * @module dsh-share-link-import/lib/seed-prompt
 */

import { IMPORTED_SOURCE } from './convert.js'

/** Provider name every imported assistant message carries. */
const IMPORTED_PROVIDER = IMPORTED_SOURCE.provider

/**
 * Whether one session is an untouched import whose prompt still needs to move
 * onto surface node 0.
 *
 * The checks are deliberately narrow: an empty system node at position 0 (the
 * import's reserved slot, still not normalized), no request recorded yet (only
 * the first request can need this), and an imported assistant message proving
 * the log came from this importer rather than from some other seed source.
 *
 * @param {object|undefined} session - the session being resumed.
 * @returns {boolean} true when the loop should start the request series.
 */
export function needsSeedPromptNormalization(session) {
  if (session === undefined || session === null) return false
  if (typeof session.requestHeader !== 'function') return false
  // A recorded request means a prompt was already admitted for this session.
  if (session.requestHeader() !== undefined) return false

  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  if (typeof session.eventAt !== 'function') return false

  const head = session.eventAt(nodes[0])
  if (head?.type !== 'system/message') return false
  // A non-empty head is either a live session's prompt or an already
  // normalized import: both are correct as they stand.
  const content = head.data?.message?.content
  if (!Array.isArray(content) || content.length > 0) return false

  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    return event.data?.message?.source?.provider === IMPORTED_PROVIDER
  }
  return false
}

/**
 * Build the `agent/pre-step` listener that normalizes an imported prompt.
 *
 * The listener wraps `next()` and only amends an `enter` decision, so every
 * other plugin's decision, message batch, and cancellation still wins. It never
 * throws into the Agent loop: a failure here must not break a conversation.
 *
 * @param {{get: (name: string) => any}} ctx - the plugin context.
 * @returns {(payload: any, next: () => Promise<any>) => Promise<any>} the waterfall listener.
 */
export function createPreStepNormalizer(ctx) {
  return async function normalizeImportedPrompt(payload, next) {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const sessionId = payload?.agent?.id
      if (sessionId === undefined) return decision
      const session = ctx.get('sessions')?.get?.(sessionId)
      if (!needsSeedPromptNormalization(session)) return decision
      return { ...decision, startsRequestSeries: true }
    } catch {
      // The unmodified decision is always a valid answer.
      return decision
    }
  }
}