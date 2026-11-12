/**
 * Minimal Server-Sent Events frame parser for outbound A2A streams.
 *
 * Tool calls currently use the blocking send path, but `tasks/resubscribe`
 * support and future streaming tools share this parser. It follows the WHATWG
 * `text/event-stream` framing rules: comment lines, multi-line `data`, `event`,
 * `id`, and `retry`.
 *
 * @module @local/dsh-a2a/outbound/sse-parser
 */

/** One dispatched SSE event. */
export interface SseFrame {
  /** `event:` value, or undefined for the default `message` type. */
  event?: string
  /** Joined `data:` lines. */
  data: string
  /** Last `id:` value, when present. */
  id?: string
  /** Reconnection delay in milliseconds, when present. */
  retry?: number
}

/**
 * Parse one `text/event-stream` body.
 *
 * @param stream - response body stream.
 * @returns an async iterator of dispatched frames.
 */
export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseFrame(raw)
        if (frame !== undefined) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    const frame = parseFrame(buffer)
    if (frame !== undefined) yield frame
  } finally {
    reader.releaseLock()
  }
}

/** Parse one blank-line-delimited frame. */
function parseFrame(raw: string): SseFrame | undefined {
  if (raw.length === 0) return undefined
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined
  const data: string[] = []
  let hasField = false

  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    hasField = true
    switch (field) {
      case 'event': event = value; break
      case 'data': data.push(value); break
      case 'id': id = value; break
      case 'retry': {
        const parsed = Number(value)
        if (Number.isSafeInteger(parsed) && parsed >= 0) retry = parsed
        break
      }
      default: break
    }
  }
  if (!hasField || data.length === 0) return undefined
  return {
    data: data.join('\n'),
    ...event === undefined ? {} : { event },
    ...id === undefined ? {} : { id },
    ...retry === undefined ? {} : { retry },
  }
}
