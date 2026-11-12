/**
 * Same-origin management API consumed by the settings panel.
 *
 * Every route is admitted through `ctx.connection.authorizeIndex`, the same
 * browser-session check that protects the GUI shell. Node edits are persisted
 * through the config editor; tokens go to the credential store and are never
 * returned.
 *
 * @module @local/dsh-a2a/admin/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { A2AService } from '../a2a-service.ts'
import type { ConnectionService, RouteContext, WebServerService } from '../dsh.ts'
import type { NodeConfig } from '../config.ts'
import {
  ADMIN_INBOUND_TOKEN_PATH,
  ADMIN_NODES_PATH,
  ADMIN_NODE_DELETE_PATH,
  ADMIN_NODE_REFRESH_PATH,
  ADMIN_NODE_TOKEN_PATH,
  ADMIN_PEER_TOKEN_PATH,
  ADMIN_STATE_PATH,
  DEFAULT_TOKEN_ENV,
} from '../../shared/constants.ts'
import { isRecord } from '../../shared/protocol.ts'
import { messageOf } from '../../shared/errors.ts'
import { BodyTooLargeError, isJsonContentType, readJsonBody } from '../http/body.ts'
import { sendEmpty, sendJson } from '../http/responses.ts'

/** Every admin route registered by this module. */
const ADMIN_PATHS = [
  ADMIN_STATE_PATH,
  ADMIN_NODES_PATH,
  ADMIN_NODE_DELETE_PATH,
  ADMIN_NODE_REFRESH_PATH,
  ADMIN_INBOUND_TOKEN_PATH,
  ADMIN_NODE_TOKEN_PATH,
  ADMIN_PEER_TOKEN_PATH,
] as const

/**
 * Register the management routes.
 *
 * @param ctx - plugin context carrying `webServer` and optionally `connection`.
 * @param service - shared A2A capability.
 */
export function registerAdminRoutes(ctx: RouteContext, service: A2AService): void {
  const web = ctx.get('webServer') as WebServerService | undefined
  if (web === undefined) return

  ctx.effect(function* () {
    for (const path of ADMIN_PATHS) {
      yield web.register({
        kind: 'exact',
        path,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          void handleAdmin(ctx, service, req, res, path).catch((error: unknown) => {
            ctx.logger.warn(`dsh-a2a: admin route ${path} failed`, error)
            if (res.headersSent) res.destroy()
            else sendJson(res, 500, { error: 'Internal error' })
          })
        },
      })
    }
  }, 'dsh-a2a: admin routes')
}

/** Dispatch one admin request after the browser-session check. */
async function handleAdmin(
  ctx: RouteContext,
  service: A2AService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const connection = ctx.get('connection') as ConnectionService | undefined
  if (connection === undefined) {
    sendJson(res, 503, { error: 'The DSH browser connection service is unavailable' })
    return
  }

  if (path === ADMIN_STATE_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendEmpty(res, 405, { allow: 'GET, HEAD' })
      return
    }
    if (!connection.authorizeIndex(req, res)) return
    const state = await service.adminState()
    if (req.method === 'HEAD') {
      const body = JSON.stringify(state)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
      })
      res.end()
      return
    }
    sendJson(res, 200, state)
    return
  }

  if (req.method !== 'POST') {
    sendEmpty(res, 405, { allow: 'POST' })
    return
  }
  if (!connection.authorizeIndex(req, res)) return
  if (!isJsonContentType(typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined)) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req, service.config.server.maxBodyBytes)
  } catch (error: unknown) {
    sendJson(res, error instanceof BodyTooLargeError ? 413 : 400, { error: messageOf(error) })
    return
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'Request body must be an object' })
    return
  }

  try {
    switch (path) {
      case ADMIN_NODES_PATH: {
        const node = parseNode(body.node)
        const token = body.token === undefined ? undefined : requireString(body.token, 'token', true)
        await service.upsertNode(node, token)
        break
      }
      case ADMIN_NODE_DELETE_PATH:
        await service.removeNode(requireString(body.id, 'id'))
        break
      case ADMIN_NODE_REFRESH_PATH:
        await service.refreshNode(requireString(body.id, 'id'))
        break
      case ADMIN_INBOUND_TOKEN_PATH:
        await service.setInboundToken(requireString(body.token, 'token', true))
        break
      case ADMIN_NODE_TOKEN_PATH:
        await service.setNodeToken(requireString(body.id, 'id'), requireString(body.token, 'token', true))
        break
      case ADMIN_PEER_TOKEN_PATH:
        await service.setPeerToken(requireString(body.id, 'id'), requireString(body.token, 'token', true))
        break
      default:
        sendJson(res, 404, { error: 'Unknown admin route' })
        return
    }
    sendJson(res, 200, { ok: true })
  } catch (error: unknown) {
    sendJson(res, 400, { error: messageOf(error) })
  }
}

/** Parse one node edit into configuration shape. */
function parseNode(value: unknown): NodeConfig {
  if (!isRecord(value)) throw new Error('node must be an object')
  const id = requireString(value.id, 'node.id')
  const name = requireString(value.name, 'node.name')
  const url = requireString(value.url, 'node.url')
  const auth = isRecord(value.auth)
    ? {
      mode: value.auth.mode === 'none' ? 'none' as const : 'bearer' as const,
      tokenEnv: typeof value.auth.tokenEnv === 'string' && value.auth.tokenEnv.length > 0
        ? value.auth.tokenEnv
        : DEFAULT_TOKEN_ENV,
    }
    : { mode: 'bearer' as const, tokenEnv: DEFAULT_TOKEN_ENV }
  return {
    id,
    name,
    url,
    enabled: value.enabled !== false,
    autoDiscover: value.autoDiscover !== false,
    auth,
  }
}

/** Require a string field; `allowEmpty` is used for token clearing. */
function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}
