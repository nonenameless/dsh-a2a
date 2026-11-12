/**
 * Bounded request-body reading for the JSON-RPC endpoint.
 *
 * The body is consumed through the request's async iterator so a large upload
 * applies backpressure instead of buffering without limit. The cap is checked
 * against actual received bytes, not the declared `Content-Length`.
 *
 * @module @local/dsh-a2a/http/body
 */

import type { IncomingMessage } from 'node:http'

/** Raised when a request body exceeds the configured cap. */
export class BodyTooLargeError extends Error {
  /** Configured maximum in bytes. */
  readonly limit: number

  /**
   * @param limit - configured maximum in bytes.
   */
  constructor(limit: number) {
    super(`Request body exceeds ${String(limit)} bytes`)
    this.name = 'BodyTooLargeError'
    this.limit = limit
  }
}

/**
 * Read and parse a JSON request body.
 *
 * @param req - incoming request.
 * @param maxBytes - hard cap in bytes; checked as chunks arrive.
 * @returns the parsed JSON value.
 * @throws {BodyTooLargeError} when the cap is exceeded.
 * @throws {SyntaxError} when the body is empty or not valid JSON.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string') {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) throw new BodyTooLargeError(maxBytes)
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes)
    chunks.push(buffer)
  }
  if (total === 0) throw new SyntaxError('Request body is empty')

  const text = Buffer.concat(chunks, total).toString('utf8')
  return JSON.parse(text) as unknown
}

/**
 * Whether a Content-Type header names JSON.
 *
 * @param value - raw header value.
 * @returns true for `application/json` with any parameters.
 */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

/** Media type of a server-sent event stream. */
const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream'

/**
 * Whether a response announces an event stream, which a blocking A2A call must
 * never consume: its body has no end, so reading it would buffer without bound.
 *
 * @param value - raw Content-Type header value.
 * @returns true for `text/event-stream` with any parameters.
 */
export function isEventStreamContentType(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false
  return value.split(';', 1)[0]?.trim().toLowerCase() === EVENT_STREAM_MEDIA_TYPE
}

/**
 * Read a Fetch response body as UTF-8 text with a hard byte cap applied while
 * the body arrives.
 *
 * `response.text()` and `response.json()` buffer until the peer closes, so a
 * slow or endless response from a third-party agent could exhaust the process
 * heap before any size check ran. This reader stops at the cap and cancels the
 * body.
 *
 * @param response - response whose body is read.
 * @param maxBytes - hard cap on received bytes.
 * @returns the decoded body.
 * @throws when the body exceeds `maxBytes`.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`Remote response body exceeds ${String(maxBytes)} bytes`)
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
