/**
 * Public Agent Card, health, and JSON-RPC routes.
 *
 * The Agent Card and health endpoints are deliberately unauthenticated:
 * discovery must work before a peer has a token. The JSON-RPC endpoint is the
 * only place bearer authentication is enforced.
 *
 * @module @local/dsh-a2a/http/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../config.ts'
import type { A2AService } from '../a2a-service.ts'
import type { RouteContext, WebServerService } from '../dsh.ts'
import { A2A_ERROR, type JsonRpcRequest } from '../../shared/protocol.ts'
import { BodyTooLargeError, isJsonContentType, readJsonBody } from './body.ts'
import { applyCors, allowedOrigins, resourceCorsHeaders, sendEmpty, sendJson, sendRpcRefusal } from './responses.ts'
import { verifyInboundBearer } from './auth.ts'
import {
  dispatchJsonRpc,
  idOf,
  toErrorResponse,
  validateJsonRpcRequest,
  type RpcHandler,
} from './jsonrpc.ts'
import { BEARER_REALM, HEALTH_PATH } from '../../shared/constants.ts'
import {
  createMethodHandlers,
  isStreamingMethod,
  normalizeResubscribe,
  normalizeStreamingSend,
} from '../inbound/methods.ts'

/**
 * Register the public routes on the already-mounted web server.
 *
 * @param ctx - plugin context carrying `webServer`.
 * @param config - resolved configuration.
 * @param service - shared A2A capability.
 */
export function registerPublicRoutes(ctx: RouteContext, config: Config, service: A2AService): void {
  const web = ctx.get('webServer') as WebServerService | undefined
  if (web === undefined) {
    ctx.logger.warn('dsh-a2a: web server is unavailable; inbound A2A routes are not registered')
    return
  }

  const methods = createMethodHandlers(service)
  const origins = new Set(allowedOrigins(config.server.corsOrigins, web.getOrigin()))
  if (config.server.publicUrl.length > 0) {
    try {
      origins.add(new URL(config.server.publicUrl).origin)
    } catch {
      // `resolveConfig` already rejected an invalid public URL.
    }
  }

  ctx.effect(function* () {
    for (const path of cardPaths(config)) {
      yield web.register({
        kind: 'exact',
        path,
        resource: async (request: Request) => cardResponse(service, request, origins),
      })
    }

    yield web.register({
      kind: 'exact',
      path: HEALTH_PATH,
      resource: async (request: Request) => new Response(JSON.stringify(service.health()), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...resourceCorsHeaders(request, origins),
        },
      }),
    })

    yield web.register({
      kind: 'exact',
      path: config.server.rpcPath,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void createRpcHandler(ctx, config, service, origins, methods)(req, res)
      },
    })
  }, 'dsh-a2a: public routes')
}

/**
 * Serve one Agent Card document.
 *
 * @param service - shared A2A capability.
 * @param request - Fetch request, used for CORS.
 * @param origins - admitted browser origins.
 * @returns a JSON response; 503 when the origin is not available yet.
 */
function cardResponse(service: A2AService, request: Request, origins: ReadonlySet<string>): Response {
  try {
    return new Response(JSON.stringify(service.card()), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...resourceCorsHeaders(request, origins),
      },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'Agent Card is unavailable' }), {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
}

/**
 * Handle one JSON-RPC request end to end.
 *
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param service - shared A2A capability.
 * @param req - incoming request.
 * @param res - response owning the lifecycle.
 * @param origins - admitted browser origins.
 */
export function createRpcHandler(
  ctx: RouteContext,
  config: Config,
  service: A2AService,
  origins: ReadonlySet<string>,
  methods: ReadonlyMap<string, RpcHandler> = createMethodHandlers(service),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handleRpcRequest(ctx, config, service, req, res, origins, methods)
    } catch (error: unknown) {
      ctx.logger.warn('dsh-a2a: RPC route failed', error)
      if (res.headersSent) res.destroy()
      else sendRpcRefusal(res, 500, A2A_ERROR.internalError, 'Internal error')
    }
  }
}

async function handleRpcRequest(
  ctx: RouteContext,
  config: Config,
  service: A2AService,
  req: IncomingMessage,
  res: ServerResponse,
  origins: ReadonlySet<string>,
  methods: ReadonlyMap<string, RpcHandler>,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    if (!applyCors(req, res, origins)) {
      sendJson(res, 403, { error: 'Origin is not allowed' })
      return
    }
    sendEmpty(res, 204)
    return
  }

  if (!applyCors(req, res, origins)) {
    sendJson(res, 403, { error: 'Origin is not allowed' })
    return
  }

  if (req.method !== 'POST') {
    sendEmpty(res, 405, { allow: 'POST, OPTIONS' })
    return
  }

  const rawAuthorization = req.headers.authorization
  const authorization = typeof rawAuthorization === 'string' ? rawAuthorization : undefined
  const decision = await verifyInboundBearer(ctx, config, authorization)
  if (!decision.ok) {
    if (decision.reason === 'not-configured') {
      service.noteMissingToken()
      sendRpcRefusal(
        res,
        503,
        A2A_ERROR.internalError,
        'A2A bearer authentication is not configured. Set a token in Settings → A2A network or DSH_A2A_TOKEN.',
      )
      return
    }
    sendRpcRefusal(res, 401, A2A_ERROR.invalidRequest, 'Unauthorized', {
      'www-authenticate': `Bearer realm="${BEARER_REALM}"`,
    })
    return
  }

  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !isJsonContentType(contentType)) {
    sendRpcRefusal(res, 415, A2A_ERROR.contentTypeNotSupported, 'Content-Type must be application/json')
    return
  }

  let value: unknown
  try {
    value = await readJsonBody(req, config.server.maxBodyBytes)
  } catch (error: unknown) {
    if (error instanceof BodyTooLargeError) {
      sendRpcRefusal(res, 413, A2A_ERROR.invalidRequest, error.message)
      return
    }
    sendRpcRefusal(res, 400, A2A_ERROR.parseError, 'Parse error')
    return
  }

  let request: JsonRpcRequest
  try {
    request = validateJsonRpcRequest(value)
  } catch (error: unknown) {
    const response = toErrorResponse(idOf(value), error, ctx.logger)
    sendJson(res, 400, response)
    return
  }

  if (isStreamingMethod(request.method)) {
    await handleStreamingMethod(ctx, service, request, req, res, decision.peer)
    return
  }

  const response = await dispatchJsonRpc(request, {
    config,
    service,
    logger: ctx.logger,
    methods,
    ...decision.peer === undefined ? {} : { peer: decision.peer },
  })
  sendJson(res, 200, response)
}

/** Start one SSE method or report a pre-stream validation failure. */
async function handleStreamingMethod(
  ctx: RouteContext,
  service: A2AService,
  request: JsonRpcRequest,
  req: IncomingMessage,
  res: ServerResponse,
  peer?: string,
): Promise<void> {
  try {
    const params = (request.params ?? {}) as Record<string, unknown>
    if (request.method === 'tasks/resubscribe') {
      service.streamResubscribe(normalizeResubscribe(params), request.id, req, res)
      return
    }
    const input = normalizeStreamingSend(request.method, params)
    await service.streamSend(input, request.id, req, res, peer)
  } catch (error: unknown) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, 400, toErrorResponse(request.id, error, ctx.logger))
  }
}

/** Unique card paths in serving order. */
function cardPaths(config: Config): string[] {
  return [...new Set([config.server.agentCardPath, ...config.server.agentCardAliases])]
}
