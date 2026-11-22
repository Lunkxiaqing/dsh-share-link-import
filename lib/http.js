/**
 * HTTP surface of the importer, mounted on the DSH web server.
 *
 * Three routes under one prefix, all same-origin and none of them reachable
 * from another site's page:
 *
 * - `GET  /__share-link-import/workspaces` — the workspaces a session may land in.
 * - `POST /__share-link-import/preview`    — what an import would contain.
 * - `POST /__share-link-import/import`     — write the session.
 *
 * The route is registered as a handler route (`WebRoute`), because a resource
 * route only answers GET/HEAD. Failures answer `{ok: false, code, message}`
 * with a 200, so the panel renders the plugin's own Chinese explanation
 * instead of a generic transport error.
 *
 * @module dsh-share-link-import/lib/http
 */

import { asShareError, CODES, ShareError, failurePayload } from './errors.js'
import { importShareLink, previewShareLink } from './importer.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/__share-link-import'

/** Largest JSON request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Create the Fetch-style handler, used by tests and by any fetch seam.
 * @param {object} deps - the services the importer needs.
 * @returns {(request: Request) => Promise<Response>} the handler.
 */
export function createRouteHandler(deps) {
  return async function handle(request) {
    const url = new URL(request.url)
    const refusal = refusalOf(url.origin, request.headers.get('origin'))
    if (refusal !== null) return json(403, failurePayload(refusal))
    const outcome = await dispatch(deps, {
      method: request.method,
      pathname: url.pathname,
      readBody: () => readJsonBody(() => request.text()),
      signal: request.signal,
    })
    return json(outcome.status, outcome.body)
  }
}

/**
 * Create the Node handler registered on the DSH web server.
 * @param {object} deps - the services the importer needs.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createNodeHandler(deps) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    } catch {
      writeJson(res, 400, failurePayload(new ShareError(CODES.internal, '请求地址无效。')))
      return
    }
    const refusal = refusalOf(url.origin, req.headers.origin)
    if (refusal !== null) {
      writeJson(res, 403, failurePayload(refusal))
      return
    }
    try {
      const outcome = await dispatch(deps, {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        readBody: () => readJsonBody(() => readNodeBody(req)),
      })
      writeJson(res, outcome.status, outcome.body)
    } catch (error) {
      const failure = asShareError(error, '导入分享失败')
      writeJson(res, 200, failurePayload(failure))
    }
  }
}

/**
 * Route one already-admitted request.
 * @param {object} deps - importer dependencies.
 * @param {{method: string, pathname: string, readBody: () => Promise<object>, signal?: AbortSignal}} request - the request facts.
 * @returns {Promise<{status: number, body: object}>} the response facts.
 */
async function dispatch(deps, request) {
  const route = request.pathname.startsWith(ROUTE_PREFIX)
    ? request.pathname.slice(ROUTE_PREFIX.length)
    : null
  if (route === null) {
    return { status: 404, body: failurePayload(new ShareError(CODES.internal, `未知的接口：${request.pathname}`)) }
  }
  try {
    if (route === '/workspaces') {
      if (request.method !== 'GET') return methodNotAllowed('GET')
      return { status: 200, body: await listWorkspaces(deps) }
    }
    if (route === '/preview') {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      const body = await request.readBody()
      return {
        status: 200,
        body: await previewShareLink(deps, { link: body.link, signal: request.signal }),
      }
    }
    if (route === '/import') {
      if (request.method !== 'POST') return methodNotAllowed('POST')
      const body = await request.readBody()
      return {
        status: 200,
        body: await importShareLink(deps, {
          link: body.link,
          workspaceId: body.workspaceId,
          force: body.force === true,
          signal: request.signal,
        }),
      }
    }
    return { status: 404, body: failurePayload(new ShareError(CODES.internal, `未知的接口：${request.pathname}`)) }
  } catch (error) {
    return { status: 200, body: failurePayload(asShareError(error, '导入分享失败')) }
  }
}

/**
 * List the workspaces a session may be written into.
 * @param {object} deps - importer dependencies.
 * @returns {Promise<{ok: true, workspaces: Array<{id: string, title: string, path: string}>}>} the list.
 * @throws {ShareError} when the registry is not mounted.
 */
async function listWorkspaces(deps) {
  if (typeof deps.workspaces?.list !== 'function') {
    throw new ShareError(CODES.workspacesUnavailable, '当前 DSH 没有挂载工作区服务，无法列出工作区。')
  }
  return {
    ok: true,
    workspaces: deps.workspaces.list().map(workspace => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    })),
  }
}

/**
 * Read and decode one JSON body, bounded in size.
 * @param {() => Promise<string>} readText - reads the raw body.
 * @returns {Promise<Record<string, any>>} the decoded body.
 * @throws {ShareError} `INTERNAL` for a bad or oversized body.
 */
async function readJsonBody(readText) {
  const text = await readText()
  if (text.length > MAX_BODY_BYTES) throw new ShareError(CODES.internal, '请求内容过大。')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new ShareError(CODES.internal, '请求内容不是有效的 JSON。')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ShareError(CODES.internal, '请求内容格式不正确。')
  }
  return body
}

/**
 * Read one Node request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body.
 */
function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ShareError(CODES.internal, '请求内容过大。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Refuse a request whose browser origin is a different site.
 * @param {string} selfOrigin - the serving origin.
 * @param {string|null|undefined} originHeader - the request's `Origin`.
 * @returns {ShareError|null} the refusal, or null when the request may proceed.
 */
function refusalOf(selfOrigin, originHeader) {
  if (originHeader === null || originHeader === undefined) return null
  if (originHeader === 'null') return new ShareError(CODES.linkInvalid, '拒绝来自无来源页面的请求。')
  try {
    if (new URL(originHeader).origin === selfOrigin) return null
  } catch {
    // Fall through to the refusal.
  }
  return new ShareError(CODES.linkInvalid, '拒绝跨站请求。')
}

/**
 * Build a JSON response.
 * @param {number} status - the HTTP status.
 * @param {unknown} body - the JSON body.
 * @returns {Response} the response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Write one JSON response over Node's HTTP primitives.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {unknown} body - the JSON body.
 * @returns {void}
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Answer a wrong method with `Allow`.
 * @param {string} allowed - the supported method.
 * @returns {{status: number, body: object}} the 405 outcome.
 */
function methodNotAllowed(allowed) {
  return {
    status: 405,
    body: failurePayload(new ShareError(CODES.internal, `只支持 ${allowed}。`)),
  }
}
