/**
 * Conversion of imported rounds into a v4 DSH Session event log.
 *
 * The written sequence is the one a finished conversation has:
 *
 * `session/title → turn/start → step/start → user/message → assistant/message
 *  → step/end → turn/end → … → session/end-seed`
 *
 * Nothing here schedules work: every turn is already closed and the import
 * never asks a model for anything.
 *
 * Two details are deliberate:
 * - Turn 1 carries an empty `system/message` as surface node 0. A resumed agent
 *   replaces that node with its real prompt; without it the restored history
 *   cannot be extended, because the stored format rejects a system message
 *   appended after imported messages.
 * - The log ends with an untagged `session/end-seed`, marking the imported
 *   history as seed history rather than live work.
 *
 * @module dsh-share-link-import/lib/convert
 */

/** Current logical Session format version of the running DSH generation. */
export const SESSION_FORMAT_VERSION = 4

/** Provider/model recorded on every imported assistant message. */
export const IMPORTED_SOURCE = Object.freeze({ provider: 'deepseek-share', model: 'deepseek-share' })

/** Synthetic spacing between rounds when the share carries no timestamps. */
const FALLBACK_ROUND_SPACING_MS = 60_000

/**
 * Build the seed log of one imported conversation.
 * @param {object} input - conversion input.
 * @param {Array<{question: string, answer: string, questionTime?: number, answerTime?: number}>} input.rounds - complete rounds, oldest first.
 * @param {string} input.title - the accepted session title.
 * @param {() => string} input.createId - mints one unique message id.
 * @param {number} [input.now] - epoch milliseconds used when a round carries no time.
 * @returns {{events: Array<object>, createdAt: number}} contiguous events from seq 0 and the session creation time.
 * @throws {Error} when no round is supplied; callers translate it into `SHARE_EMPTY`.
 */
export function buildSessionEvents(input) {
  const { rounds, title, createId } = input
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new Error('no complete round to import')
  }
  const now = Number.isSafeInteger(input.now) ? input.now : Date.now()

  /** @type {Array<object>} */
  const events = []
  let time = 0

  /** Append one event with the next contiguous seq at the current time. */
  const add = (type, data, extra) => {
    events.push({ type, seq: events.length, time, data, ...extra })
  }
  /** Move the clock forward to `value` (never backwards). */
  const at = (value) => {
    time = Math.max(time, value)
  }

  // The title is log-only; pinning it to `user` keeps an automatic title
  // generation from ever replacing the share's own title.
  at(firstTimestamp(rounds, now))
  add('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  const createdAt = time

  let turn = 0
  for (const round of rounds) {
    turn += 1
    const step = 1
    at(round.questionTime ?? time + FALLBACK_ROUND_SPACING_MS)
    add('turn/start', { turn })
    add('step/start', { turn, step })
    if (turn === 1) {
      add('system/message', {
        turn,
        step,
        message: { id: createId(), role: 'system', content: [], source: { kind: 'system-prompt' } },
      }, { surfaceOp: 'append' })
    }
    add('user/message', {
      id: createId(),
      role: 'user',
      content: [{ type: 'text', text: round.question }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    at(round.answerTime ?? time + FALLBACK_ROUND_SPACING_MS)
    add('assistant/message', {
      turn,
      step,
      message: {
        id: createId(),
        role: 'assistant',
        content: [{ type: 'text', text: round.answer }],
        source: { kind: 'model', ...IMPORTED_SOURCE },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    add('step/end', { turn, step })
    add('turn/end', { turn, reason: { kind: 'completed' } })
  }

  add('session/end-seed', {})
  return { events, createdAt }
}

/**
 * The earliest round timestamp, or `now` when the share carries none.
 * @param {Array<{questionTime?: number, answerTime?: number}>} rounds - the rounds.
 * @param {number} now - fallback timestamp.
 * @returns {number} the session creation time.
 */
function firstTimestamp(rounds, now) {
  const first = rounds[0]
  const candidates = [first.questionTime, first.answerTime].filter(value => Number.isSafeInteger(value))
  return candidates.length === 0 ? now : Math.min(...candidates)
}

/**
 * Check the invariants a written log must satisfy, independent of storage.
 * @param {Array<object>} events - the built events.
 * @returns {{ok: boolean, problems: string[]}} whether the log is well formed, and what is wrong.
 */
export function auditEvents(events) {
  const problems = []
  let openTurn = null
  let openStep = null
  events.forEach((event, index) => {
    if (event.seq !== index) problems.push(`event ${index} has seq ${event.seq}`)
    if (index > 0 && event.time < events[index - 1].time) problems.push(`event ${index} moves time backwards`)
    switch (event.type) {
      case 'turn/start':
        if (openTurn !== null) problems.push(`turn ${event.data.turn} starts while ${openTurn} is open`)
        openTurn = event.data.turn
        break
      case 'turn/end':
        if (openTurn !== event.data.turn) problems.push(`turn ${event.data.turn} ends while ${openTurn} is open`)
        openTurn = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      case 'user/message':
      case 'assistant/message':
      case 'system/message':
        if (event.surfaceOp !== 'append') problems.push(`event ${index} (${event.type}) is missing surfaceOp`)
        if (openTurn === null || openStep === null) problems.push(`event ${index} (${event.type}) is outside a step`)
        break
      default:
        break
    }
  })
  if (openTurn !== null || openStep !== null) problems.push('the log leaves a turn or step open')
  const last = events[events.length - 1]
  if (last === undefined || last.type !== 'session/end-seed') problems.push('the log does not end with session/end-seed')
  if (!events.some(event => event.type === 'session/title')) problems.push('the log carries no title')
  return { ok: problems.length === 0, problems }
}
