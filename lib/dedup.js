/**
 * Import journal: which share was already imported into this DSH home.
 *
 * The journal is deliberately independent of the session log — it records the
 * `share id → session id` decision that dedup needs, and is written atomically
 * so a crash cannot leave it half-parsed. A missing or unreadable journal is
 * treated as empty: dedup must never block an import because of a bad file.
 *
 * @module dsh-share-link-import/lib/dedup
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Journal format version. */
const JOURNAL_VERSION = 1

/**
 * Resolve this DSH home directory.
 * @returns {string} the absolute DSH home.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(home, '.dsh')
}

/**
 * The journal file of one DSH home.
 * @param {string} home - the DSH home directory.
 * @returns {string} absolute journal path.
 */
export function journalPath(home) {
  return join(home, 'share-link-import', 'index.json')
}

/**
 * Read the journal.
 * @param {string} file - absolute journal path.
 * @returns {Promise<{version: number, imports: Record<string, {sessionId: string, title: string, importedAt: number}>}>} the journal, empty when absent or unreadable.
 */
export async function readJournal(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.imports !== 'object' || parsed.imports === null) {
      return emptyJournal()
    }
    return { version: JOURNAL_VERSION, imports: parsed.imports }
  } catch {
    return emptyJournal()
  }
}

/**
 * Look up one share id in the journal.
 * @param {string} file - absolute journal path.
 * @param {string} shareId - the share id.
 * @returns {Promise<{sessionId: string, title: string, importedAt: number}|undefined>} the previous import.
 */
export async function findImport(file, shareId) {
  const journal = await readJournal(file)
  const entry = journal.imports[shareId]
  if (entry === undefined || typeof entry.sessionId !== 'string') return undefined
  return {
    sessionId: entry.sessionId,
    title: typeof entry.title === 'string' ? entry.title : '',
    importedAt: Number.isSafeInteger(entry.importedAt) ? entry.importedAt : 0,
  }
}

/**
 * Record one import, keeping every earlier entry.
 * @param {string} file - absolute journal path.
 * @param {string} shareId - the share id.
 * @param {{sessionId: string, title: string, importedAt?: number}} entry - what was imported.
 * @returns {Promise<void>} resolution after the journal is durable.
 */
export async function recordImport(file, shareId, entry) {
  const journal = await readJournal(file)
  journal.imports[shareId] = {
    sessionId: entry.sessionId,
    title: entry.title,
    importedAt: Number.isSafeInteger(entry.importedAt) ? entry.importedAt : Date.now(),
  }
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: JOURNAL_VERSION, imports: journal.imports }, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * An empty journal.
 * @returns {{version: number, imports: Record<string, never>}} the empty shape.
 */
function emptyJournal() {
  return { version: JOURNAL_VERSION, imports: {} }
}
