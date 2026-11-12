/**
 * Server-Sent Events writer for A2A streaming responses.
 *
 * A2A sends one JSON-RPC response envelope per `data:` frame. The writer owns
 * the response after the initial 200, so every later failure is delivered as a
 * final JSON-RPC error frame rather than a second HTTP status.
 *
 * @module @local/dsh-a2a/http/sse
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonRpcId, TaskEvent } from '../../shared/protocol.ts'
import type { A2AProtocolError } from '../../shared/errors.ts'

/** Heartbeat cadence; proxies commonly time out an idle stream at 30-60 s. */
const HEARTBEAT_MS = 15_000

/** Writer handed to the streaming method implementation. */
export interface SseWriter {
  /** Send one task event as a JSON-RPC success frame. */
  send(event: TaskEvent): void
  /** Send one JSON-RPC error frame and close. */
  fail(error: A2AProtocolError): void
  /** Close the response and release resources. */
  close(): void
  /** Whether the stream is already closed. */
  readonly closed: boolean
  /**
   * Register a cleanup callback invoked exactly once when the stream closes.
   * @param callback - cleanup to run on close.
   */
  onClose(callback: () => void): void
}

/**
 * Open one SSE response.
 *
 * @param req - request whose close event ends the stream.
 * @param res - response owning the stream.
 * @param id - JSON-RPC request id echoed in every frame.
 * @returns the writer.
 */
export function openSse(req: IncomingMessage, res: ServerResponse, id: JsonRpcId): SseWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  res.socket?.setNoDelay(true)

  let closed = false
  const closeCallbacks: Array<() => void> = []

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return
    try {
      res.write(': heartbeat\n\n')
    } catch {
      close()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const callback of closeCallbacks.splice(0)) {
      try {
        callback()
      } catch {
        // Cleanup callbacks are bookkeeping; a failure here cannot repair the stream.
      }
    }
    if (!res.writableEnded) res.end()
  }

  const onClose = (): void => { close() }
  // `req`'s 'close' fires when the request body is consumed, which for a POST
  // is immediately; only the response closing means the SSE client left.
  req.once('aborted', onClose)
  res.once('close', onClose)
  res.once('error', onClose)

  const writeFrame = (payload: unknown): void => {
    if (closed || res.writableEnded) return
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      close()
    }
  }

  return {
    get closed() { return closed },
    send(event) {
      writeFrame({ jsonrpc: '2.0', id, result: event })
      if (event.kind === 'status-update' && event.final) {
        // Let the write reach the socket before ending the response.
        queueMicrotask(close)
      }
    },
    fail(error) {
      writeFrame(error.toJsonRpc(id))
      close()
    },
    close,
    onClose(callback) {
      if (closed) {
        callback()
        return
      }
      closeCallbacks.push(callback)
    },
  }
}
