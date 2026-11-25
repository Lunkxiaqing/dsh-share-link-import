/**
 * DeepSeek share-link import: Host half.
 *
 * Mounts three routes on the DSH web server and writes an imported public
 * DeepSeek conversation into the chosen workspace as a finished v4 Session.
 * Nothing here calls a model, and nothing reads a DeepSeek credential: the
 * conversation is read from the same anonymous endpoint a logged-out browser
 * uses.
 *
 * It also gives an imported session the same request shape a live conversation
 * has: the first request after the import starts a request series, so DSH
 * normalizes the system prompt onto surface node 0 instead of appending it
 * after the imported history (see `lib/seed-prompt.js`).
 *
 * @module dsh-share-link-import
 */

import { createNodeHandler, ROUTE_PREFIX } from './lib/http.js'
import { dshHome, journalPath } from './lib/dedup.js'
import { createPreStepNormalizer } from './lib/seed-prompt.js'

/** Cordis plugin name, matching the bundle row this package inserts. */
export const name = 'dsh-share-link-import'

/** The importer serves HTTP and observes the agent loop; neither is optional. */
export const inject = ['webServer']

/**
 * Mount the import routes and the prompt-placement listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const handler = createNodeHandler({
    get workspaces() {
      return ctx.get('workspaceRegistry')
    },
    get persistence() {
      return ctx.get('sessionPersistence')
    },
    get projectionCache() {
      return ctx.get('sessionProjectionCache')
    },
    journalFile: journalPath(dshHome()),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    }),
    'share-link-import: routes',
  )

  ctx.effect(
    () => ctx.on('agent/pre-step', createPreStepNormalizer(ctx)),
    'share-link-import: seed prompt placement',
  )
}
