/**
 * Small response helpers shared by the public and admin routes.
 *
 * CORS is opt-in per origin: server-to-server A2A calls carry no Origin and
 * pass through, while browser calls are admitted only for the bound origin,
 * the configured public URL, or an explicitly listed origin.
 *
 * @module @local/dsh-a2a/http/responses
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Headers every JSON response carries. */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/**
 * Write one JSON response.
 *
 * @param res - response owning the lifecycle.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 * @param headers - additional headers, applied after the defaults.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
  res.end(body)
}

/**
 * Write one empty response.
 *
 * @param res - response owning the lifecycle.
 * @param status - HTTP status code.
 * @param headers - response headers.
 */
export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end()
}

/**
 * Write a JSON-RPC-shaped refusal before envelope dispatch.
 *
 * @param res - response owning the lifecycle.
 * @param status - HTTP status code.
 * @param code - JSON-RPC error code.
 * @param message - peer-safe message.
 * @param headers - additional headers such as `WWW-Authenticate`.
 */
export function sendRpcRefusal(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message } }, headers)
}

/**
 * Apply CORS headers for one request.
 *
 * @param req - incoming request.
 * @param res - response receiving the headers.
 * @param allowedOrigins - exact origins admitted.
 * @returns false when the request carries a disallowed Origin.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (!allowedOrigins.has(origin)) return false
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'Origin')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
  return true
}

/**
 * Compute the CORS allow-list from configuration plus the bound origin.
 *
 * @param configured - explicit `server.corsOrigins`.
 * @param origin - bound web-server origin, when available.
 * @returns exact origins admitted for browser calls.
 */
export function allowedOrigins(configured: readonly string[], origin: string): ReadonlySet<string> {
  const allowed = new Set<string>(configured)
  if (origin.length > 0) {
    try {
      allowed.add(new URL(origin).origin)
    } catch {
      // A malformed bound origin cannot contribute an allow-list entry; the
      // server would already have failed to bind a usable URL.
    }
  }
  return allowed
}

/**
 * Build CORS headers for a Fetch resource response.
 *
 * @param request - Fetch request carrying an optional Origin.
 * @param origins - exact origins admitted.
 * @returns headers to merge into the response.
 */
export function resourceCorsHeaders(request: Request, origins: ReadonlySet<string>): Record<string, string> {
  const origin = request.headers.get('origin')
  if (origin === null || !origins.has(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
  }
}
