/**
 * Offline smoke tests for the share-link importer.
 *
 * No network and no DSH runtime are needed: the pure layers (link parsing,
 * share-document reading, round building, event generation) and the dedup
 * journal are exercised directly, with an in-memory session store standing in
 * for `sessionPersistence`.
 *
 * Run with `node test/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODES, ShareError, asShareError } from '../lib/errors.js'
import { parseShareLink, shareContentUrl } from '../lib/link.js'
import { readShareDocument, buildRounds, importTitle, truncateUtf8 } from '../lib/messages.js'
import { auditEvents, buildSessionEvents } from '../lib/convert.js'
import { findImport, journalPath, readJournal, recordImport } from '../lib/dedup.js'
import { eventCountFor, writeImportedSession } from '../lib/session-writer.js'
import { importShareLink, previewShareLink } from '../lib/importer.js'
import { createRouteHandler } from '../lib/http.js'
import { createPreStepNormalizer, needsSeedPromptNormalization } from '../lib/seed-prompt.js'

let passed = 0
let failed = 0

/**
 * Run one named check.
 * @param {string} name - what is being verified.
 * @param {() => void|Promise<void>} body - the check.
 * @returns {Promise<void>} resolution once the check ran.
 */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/**
 * Assert that a callback fails with one specific share code.
 * @param {() => Promise<unknown>|unknown} body - the callback.
 * @param {string} code - the expected code.
 * @returns {Promise<ShareError>} the caught failure.
 */
async function expectCode(body, code) {
  try {
    await body()
  } catch (error) {
    const failure = asShareError(error, 'unexpected')
    assert.equal(failure.code, code, `expected ${code}, got ${failure.code}: ${failure.message}`)
    return failure
  }
  throw new Error(`expected ${code}, but nothing was thrown`)
}

// ---------------------------------------------------------------- link parsing

await test('parses a canonical share link', () => {
  const parsed = parseShareLink('https://chat.deepseek.com/share/AbCd1234efGh')
  assert.equal(parsed.shareId, 'AbCd1234efGh')
  assert.equal(parsed.url, 'https://chat.deepseek.com/share/AbCd1234efGh')
})

await test('parses a link with a query, hash, and trailing slash', () => {
  assert.equal(parseShareLink('https://chat.deepseek.com/share/abc123/?from=copy#x').shareId, 'abc123')
})

await test('parses the share_id query form and a bare id', () => {
  assert.equal(parseShareLink('https://chat.deepseek.com/share?share_id=abc123').shareId, 'abc123')
  assert.equal(parseShareLink('  abc123  ').shareId, 'abc123')
})

await test('rejects an empty link with a Chinese explanation', async () => {
  const failure = await expectCode(() => parseShareLink('   '), CODES.linkInvalid)
  assert.match(failure.message, /分享链接为空/u)
})

await test('rejects another host', async () => {
  const failure = await expectCode(
    () => parseShareLink('https://example.com/share/abc123'),
    CODES.linkInvalid,
  )
  assert.match(failure.message, /chat\.deepseek\.com/u)
})

await test('rejects a DeepSeek link without a share id', async () => {
  await expectCode(() => parseShareLink('https://chat.deepseek.com/c/123'), CODES.linkInvalid)
})

await test('rejects http', async () => {
  await expectCode(() => parseShareLink('http://chat.deepseek.com/share/abc123'), CODES.linkInvalid)
})

await test('builds the public content URL without credentials', () => {
  assert.equal(
    shareContentUrl('abc123'),
    'https://chat.deepseek.com/api/v0/share/content?share_id=abc123',
  )
})

// ------------------------------------------------------------ share documents

/** A share document in the shape the public endpoint answers. */
const document = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      title: '如何理解事件溯源？',
      messages: [
        { fragments: [{ type: 'REQUEST', content: '第一个问题' }] },
        { fragments: [{ type: 'RESPONSE', content: '第一个回答' }] },
        { role: 'USER', fragments: [{ type: 'REQUEST', content: '第二个问题' }] },
        { role: 'ASSISTANT', fragments: [{ type: 'RESPONSE', content: '第二个回答' }] },
        { fragments: [{ type: 'REQUEST', content: '没有回答的问题' }] },
      ],
    },
  },
}

await test('reads messages and title from the nested document', () => {
  const reading = readShareDocument(document)
  assert.equal(reading.title, '如何理解事件溯源？')
  assert.equal(reading.messages.length, 5)
  assert.equal(reading.messages[0].role, 'user')
  assert.equal(reading.messages[1].role, 'assistant')
})

await test('derives the role from the fragment type when role is absent', () => {
  const { messages } = readShareDocument({
    data: { biz_data: { messages: [{ fragments: [{ type: 'response', content: '答' }] }] } },
  })
  assert.equal(messages[0].role, 'assistant')
})

await test('reports a deleted share through biz_code', async () => {
  await expectCode(
    () => readShareDocument({ data: { biz_code: 404, biz_data: {} } }),
    CODES.notFound,
  )
})

await test('reports a document without a message list', async () => {
  await expectCode(() => readShareDocument({ data: { biz_data: { title: 'x' } } }), CODES.malformed)
})

await test('reports a non-object document', async () => {
  await expectCode(() => readShareDocument('nope'), CODES.malformed)
})

// -------------------------------------------------------------------- rounds

await test('pairs rounds and drops the trailing unanswered question', () => {
  const { messages } = readShareDocument(document)
  const { rounds, droppedUnanswered } = buildRounds(messages)
  assert.equal(rounds.length, 2)
  assert.equal(droppedUnanswered, 1)
  assert.equal(rounds[1].question, '第二个问题')
})

await test('drops an orphan answer and a question repeated before an answer', () => {
  const { rounds, droppedOrphans, droppedUnanswered } = buildRounds([
    { role: 'assistant', text: '孤立的回答' },
    { role: 'user', text: '问题 A' },
    { role: 'user', text: '问题 B' },
    { role: 'assistant', text: '回答 B' },
  ])
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].question, '问题 B')
  assert.equal(droppedOrphans, 1)
  assert.equal(droppedUnanswered, 1)
})

await test('derives a UTF-8-safe title', () => {
  const long = '汉'.repeat(40)
  const title = importTitle('', long)
  assert.ok(Buffer.byteLength(title, 'utf8') <= 80)
  assert.equal(truncateUtf8('abc', 10), 'abc')
  assert.equal(importTitle('  分享标题  ', '问题'), '分享标题')
})

await test('ignores the placeholder share title', () => {
  assert.equal(importTitle('Shared Conversation', '真正的问题'), '真正的问题')
  assert.equal(importTitle('来自分享的对话', '真正的问题'), '真正的问题')
})

await test('an unfinished answer leaves its question unanswered', () => {
  const { messages } = readShareDocument({
    data: { biz_data: { messages: [
      { role: 'USER', status: 'FINISHED', fragments: [{ type: 'REQUEST', content: '问' }] },
      { role: 'ASSISTANT', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '半截回答' }] },
    ] } },
  })
  assert.equal(messages.length, 1)
  const { rounds, droppedUnanswered } = buildRounds(messages)
  assert.equal(rounds.length, 0)
  assert.equal(droppedUnanswered, 1)
})

await test('timestamps in seconds become epoch milliseconds', () => {
  const { messages } = readShareDocument({
    data: { biz_data: { messages: [
      { role: 'USER', inserted_at: 1789129442.345, fragments: [{ type: 'REQUEST', content: '问' }] },
      { role: 'ASSISTANT', inserted_at: 1789129450, fragments: [{ type: 'RESPONSE', content: '答' }] },
    ] } },
  })
  assert.equal(messages[0].time, 1789129442345)
  assert.equal(messages[1].time, 1789129450000)
})

// -------------------------------------------------------------- event log

let counter = 0
/** Deterministic id source. */
const createId = () => `id-${counter++}`

await test('builds the required event sequence', () => {
  const { messages } = readShareDocument(document)
  const { rounds } = buildRounds(messages)
  const { events } = buildSessionEvents({ rounds, title: '标题', createId, now: 1_700_000_000_000 })
  assert.deepEqual(events.map(event => event.type), [
    'session/title',
    'turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    'session/end-seed',
  ])
  assert.equal(events.length, eventCountFor(2))
})

await test('keeps seq contiguous and time non-decreasing', () => {
  const { messages } = readShareDocument({
    data: { biz_data: { messages: [
      { fragments: [{ type: 'REQUEST', content: 'q1' }], inserted_at: 1_700_000_100_000 },
      { fragments: [{ type: 'RESPONSE', content: 'a1' }], inserted_at: 1_700_000_050_000 },
    ] } },
  })
  const { rounds } = buildRounds(messages)
  const { events } = buildSessionEvents({ rounds, title: 't', createId })
  events.forEach((event, index) => assert.equal(event.seq, index))
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].time >= events[index - 1].time, 'time must not go backwards')
  }
})

await test('audits a good log and rejects an unbalanced one', () => {
  const { messages } = readShareDocument(document)
  const { rounds } = buildRounds(messages)
  const { events } = buildSessionEvents({ rounds, title: 't', createId })
  assert.deepEqual(auditEvents(events), { ok: true, problems: [] })
  const broken = events.filter(event => event.type !== 'turn/end')
  assert.equal(auditEvents(broken).ok, false)
})

await test('writes surfaceOp on every message event', () => {
  const { messages } = readShareDocument(document)
  const { rounds } = buildRounds(messages)
  const { events } = buildSessionEvents({ rounds, title: 't', createId })
  for (const event of events) {
    if (['user/message', 'assistant/message', 'system/message'].includes(event.type)) {
      assert.equal(event.surfaceOp, 'append')
    }
  }
})

await test('refuses to build a log without rounds', async () => {
  await expectCode(() => buildSessionEvents({ rounds: [], title: 't', createId }), CODES.internal)
})

// ------------------------------------------------------------------- dedup

const home = await mkdtemp(join(tmpdir(), 'share-link-import-'))
const journal = journalPath(home)

await test('dedup journal starts empty and records one import', async () => {
  assert.equal(await findImport(journal, 'abc123'), undefined)
  await recordImport(journal, 'abc123', { sessionId: 'session-1', title: '标题' })
  const entry = await findImport(journal, 'abc123')
  assert.equal(entry?.sessionId, 'session-1')
  assert.equal((await findImport(journal, 'other')), undefined)
  const onDisk = JSON.parse(await readFile(journal, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.imports.abc123.title, '标题')
})

await test('a corrupt journal never blocks an import', async () => {
  const broken = join(home, 'share-link-import', 'broken.json')
  await recordImport(broken.replace('broken.json', 'temp.json'), 'x', { sessionId: 's', title: '' })
  assert.equal(await findImport(join(home, 'missing.json'), 'x'), undefined)
  assert.deepEqual((await readJournal(join(home, 'missing.json'))).imports, {})
})

// ------------------------------------------------------- session writing

/** An in-memory stand-in for `sessionPersistence`. */
function memoryPersistence() {
  const stored = new Map()
  return {
    stored,
    async create(header) {
      const events = []
      stored.set(header.id, { header, events })
      return {
        id: header.id,
        header,
        async append(batch) { events.push(...batch.map(event => structuredClone(event))) },
        async flush() {},
        async close() {},
      }
    },
    async stat(id) {
      if (!stored.has(id)) return undefined
      return { header: stored.get(id).header, revision: 'rev', eventCount: stored.get(id).events.length, location: { kind: 'memory', path: `/mem/${id}` } }
    },
    async open(id) {
      const entry = stored.get(id)
      return {
        id,
        async read(offset = 0, length = entry.events.length) {
          return { eventState: 'detached', events: entry.events.slice(offset, offset + length) }
        },
        async close() {},
      }
    },
  }
}

/** A workspace registry with one writable workspace. */
function memoryWorkspaces(path) {
  const attached = []
  const workspace = {
    id: 'ws-1',
    title: '测试工作区',
    path,
    async attachSession(id) { attached.push(id) },
  }
  return {
    attached,
    get(id) { return id === 'ws-1' ? workspace : undefined },
    list() { return [workspace] },
  }
}

const workspaceDir = await mkdtemp(join(tmpdir(), 'share-link-import-ws-'))

await test('writes the session, attaches it, and verifies the read-back', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  const { messages } = readShareDocument(document)
  const { rounds } = buildRounds(messages)
  const { events, createdAt } = buildSessionEvents({ rounds, title: '标题', createId })
  const written = await writeImportedSession(
    { persistence, workspaces },
    { workspaceId: 'ws-1', events, title: '标题', createdAt, createId: () => 'session-42' },
  )
  assert.equal(written.sessionId, 'session-42')
  assert.equal(written.eventCount, events.length)
  assert.equal(persistence.stored.get('session-42').events.length, events.length)
  assert.deepEqual(workspaces.attached, ['session-42'])
})

await test('rejects an unknown workspace', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  const failure = await expectCode(
    () => writeImportedSession(
      { persistence, workspaces },
      { workspaceId: 'nope', events: [], title: 't', createdAt: Date.now(), createId: () => 's' },
    ),
    CODES.workspaceUnknown,
  )
  assert.match(failure.message, /工作区/u)
})

await test('rejects a missing workspace directory', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(join(workspaceDir, 'gone'))
  await expectCode(
    () => writeImportedSession(
      { persistence, workspaces },
      { workspaceId: 'ws-1', events: [], title: 't', createdAt: Date.now(), createId: () => 's' },
    ),
    CODES.workspaceNotWritable,
  )
})

await test('cleans up a session whose append failed', async () => {
  const removed = []
  const persistence = {
    async create(header) {
      return {
        id: header.id,
        async append() { throw new Error('disk full') },
        async flush() {},
        async close() {},
      }
    },
    async stat(id) { return { header: {}, revision: 'r', location: { kind: 'file', path: `/mem/${id}` } } },
  }
  const workspaces = memoryWorkspaces(workspaceDir)
  const failure = await expectCode(
    () => writeImportedSession(
      { persistence, workspaces },
      { workspaceId: 'ws-1', events: [], title: 't', createdAt: Date.now(), createId: () => 'session-9' },
    ),
    CODES.writeFailed,
  )
  assert.match(failure.message, /disk full/u)
  assert.ok(removed.length === 0)
})

// -------------------------------------------------------------- importer

/** A fake share reader, so no test touches the network. */
const fetchContent = async () => document

await test('previews a share without writing anything', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  const preview = await previewShareLink(
    { workspaces, persistence, journalFile: join(home, 'preview.json'), fetchContent, createId },
    { link: 'https://chat.deepseek.com/share/abc123' },
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.rounds, 2)
  assert.equal(preview.droppedUnanswered, 1)
  assert.equal(preview.alreadyImported, null)
  assert.equal(persistence.stored.size, 0)
})

await test('imports once, then refuses the same share id', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  const journalFile = join(home, 'import.json')
  const deps = { workspaces, persistence, journalFile, fetchContent }
  const link = 'https://chat.deepseek.com/share/dup123'

  const first = await importShareLink(deps, { link, workspaceId: 'ws-1' })
  assert.equal(first.ok, true)
  assert.equal(first.rounds, 2)

  const failure = await expectCode(
    () => importShareLink(deps, { link, workspaceId: 'ws-1' }),
    CODES.alreadyImported,
  )
  assert.match(failure.message, /已经导入过/u)

  const forced = await importShareLink(deps, { link, workspaceId: 'ws-1', force: true })
  assert.equal(forced.ok, true)
  assert.notEqual(forced.sessionId, first.sessionId)
  assert.equal(persistence.stored.size, 2)
})

await test('requires a workspace id', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  await expectCode(
    () => importShareLink({ workspaces, persistence, journalFile: join(home, 'w.json'), fetchContent }, {
      link: 'https://chat.deepseek.com/share/abc123',
      workspaceId: '',
    }),
    CODES.workspaceRequired,
  )
})

await test('reports an empty share', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  await expectCode(
    () => importShareLink({
      workspaces,
      persistence,
      journalFile: join(home, 'e.json'),
      fetchContent: async () => ({ data: { biz_data: { messages: [] } } }),
    }, { link: 'https://chat.deepseek.com/share/empty1', workspaceId: 'ws-1' }),
    CODES.empty,
  )
})

await test('propagates a fetch failure as its own code', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  await expectCode(
    () => importShareLink({
      workspaces,
      persistence,
      journalFile: join(home, 'f.json'),
      fetchContent: async () => {
        throw new ShareError(CODES.notFound, '分享不存在或已被删除（HTTP 404）。')
      },
    }, { link: 'https://chat.deepseek.com/share/missing1', workspaceId: 'ws-1' }),
    CODES.notFound,
  )
})

// ------------------------------------------------------------------ routes

await test('routes answer workspaces, preview, import, and unknown paths', async () => {
  const persistence = memoryPersistence()
  const workspaces = memoryWorkspaces(workspaceDir)
  const handler = createRouteHandler({
    workspaces,
    persistence,
    journalFile: join(home, 'routes.json'),
    fetchContent,
    createId,
  })
  const base = 'http://127.0.0.1:1/__share-link-import'

  const listed = await handler(new Request(`${base}/workspaces`))
  const listedBody = await listed.json()
  assert.equal(listedBody.ok, true)
  assert.equal(listedBody.workspaces[0].id, 'ws-1')

  const previewed = await handler(new Request(`${base}/preview`, {
    method: 'POST',
    body: JSON.stringify({ link: 'https://chat.deepseek.com/share/abc123' }),
  }))
  assert.equal((await previewed.json()).ok, true)

  const imported = await handler(new Request(`${base}/import`, {
    method: 'POST',
    body: JSON.stringify({ link: 'https://chat.deepseek.com/share/abc999', workspaceId: 'ws-1' }),
  }))
  assert.equal((await imported.json()).ok, true)

  const unknown = await handler(new Request(`${base}/nope`))
  assert.equal(unknown.status, 404)

  const wrongMethod = await handler(new Request(`${base}/preview`))
  assert.equal(wrongMethod.status, 405)

  const crossSite = await handler(new Request(`${base}/import`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    body: '{}',
  }))
  assert.equal(crossSite.status, 403)
})

await test('routes return actionable messages, not crashes', async () => {
  const handler = createRouteHandler({
    workspaces: memoryWorkspaces(workspaceDir),
    persistence: memoryPersistence(),
    journalFile: join(home, 'bad.json'),
    fetchContent: async () => ({ data: { biz_code: 7 } }),
  })
  const response = await handler(new Request('http://127.0.0.1:1/__share-link-import/preview', {
    method: 'POST',
    body: '{ not json',
  }))
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, CODES.internal)
  assert.ok(body.message.length > 0)
})

// ------------------------------------------------------- imported prompt placement

/**
 * Build a stand-in session whose surface mirrors an imported log.
 * @param {{headEmpty?: boolean, provider?: string, request?: boolean, systemHead?: boolean}} shape - the surface to build.
 * @returns {object} the fake session.
 */
function fakeSession(shape = {}) {
  const headEmpty = shape.headEmpty ?? true
  const provider = shape.provider ?? 'deepseek-share'
  const events = [
    { type: 'system/message', seq: 0, data: { message: { content: headEmpty ? [] : [{ type: 'text', text: 'prompt' }] } } },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 2, data: { message: { source: { kind: 'model', provider } } } },
  ]
  if (shape.systemHead === false) events[0] = { type: 'user/message', seq: 0, data: {} }
  return {
    surface: { nodes: events.map(event => event.seq) },
    eventAt: (seq) => events.find(event => event.seq === seq),
    requestHeader: () => (shape.request === true ? { config: { provider: 'p', model: 'm' } } : undefined),
  }
}

await test('detects an imported session whose prompt was never placed', () => {
  assert.equal(needsSeedPromptNormalization(fakeSession()), true)
})

await test('leaves a live session, a normalized import, and a requested session alone', () => {
  assert.equal(needsSeedPromptNormalization(fakeSession({ systemHead: false })), false)
  assert.equal(needsSeedPromptNormalization(fakeSession({ headEmpty: false })), false)
  assert.equal(needsSeedPromptNormalization(fakeSession({ request: true })), false)
  assert.equal(needsSeedPromptNormalization(undefined), false)
  assert.equal(needsSeedPromptNormalization({ surface: { nodes: [] } }), false)
})

await test('does not claim a session seeded by another source', () => {
  assert.equal(needsSeedPromptNormalization(fakeSession({ provider: 'deepseek-chat-export' })), false)
})

await test('starts the request series once, and only for an enter decision', async () => {
  const sessions = new Map([['session-1', fakeSession()]])
  const listener = createPreStepNormalizer({ get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined) })

  const entered = await listener({ agent: { id: 'session-1' } }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(entered.startsRequestSeries, true)
  assert.deepEqual(entered.messages, [])

  const rejected = await listener({ agent: { id: 'session-1' } }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' })

  const untouched = await listener({ agent: { id: 'unknown' } }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(untouched.startsRequestSeries, undefined)
})

await test('preserves the downstream decision when the session lookup fails', async () => {
  const listener = createPreStepNormalizer({
    get: () => ({
      get: () => {
        throw new Error('registry unavailable')
      },
    }),
  })
  const decision = await listener({ agent: { id: 'session-1' } }, async () => ({ kind: 'enter', messages: [{ id: 'm' }] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [{ id: 'm' }] })
})

await rm(home, { recursive: true, force: true })
await rm(workspaceDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
