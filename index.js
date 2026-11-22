/**
 * DeepSeek share-link import: Host half.
 *
 * Mounts three routes on the DSH web server and writes an imported public
 * DeepSeek conversation into the chosen workspace as a finished v4 Session.
 * Nothing here calls a model, and nothing reads a DeepSeek credential: the
 * conversation is read from the same anonymous endpoint a logged-out browser
 * uses.
 *
 * @module dsh-share-link-import
 */

import { createNodeHandler, ROUTE_PREFIX } from './lib/http.js'
import { dshHome, journalPath } from './lib/dedup.js'

/** Cordis plugin name, matching the bundle row this package inserts. */
export const name = 'dsh-share-link-import'

/** The importer serves HTTP; it needs nothing else to activate. */
export const inject = ['webServer']

/**
 * Mount the import routes.
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
}
