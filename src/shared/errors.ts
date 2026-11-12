/**
 * Structured failures and their JSON-RPC projection.
 *
 * A protocol fault carries the numeric code that appears on the wire. The
 * message is safe to return to a peer: it names a field, a state, or an
 * operation, never a token, a header, or a message body.
 *
 * @module @local/dsh-a2a/errors
 */

import { A2A_ERROR, type JsonRpcError, type JsonRpcId } from './protocol.ts'

/** One failure that maps directly onto a JSON-RPC error object. */
export class A2AProtocolError extends Error {
  /** JSON-RPC error code from {@link A2A_ERROR}. */
  readonly code: number

  /** Optional diagnostic data; must never contain secrets or request bodies. */
  readonly data: unknown

  /**
   * @param code - JSON-RPC error code.
   * @param message - peer-safe diagnostic.
   * @param data - optional structured detail.
   */
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'A2AProtocolError'
    this.code = code
    this.data = data
  }

  /**
   * Project this failure onto one JSON-RPC response with the request identity.
   * @param id - request id to echo.
   * @returns a JSON-RPC error envelope.
   */
  toJsonRpc(id: JsonRpcId): JsonRpcError {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: this.code,
        message: this.message,
        ...this.data === undefined ? {} : { data: this.data },
      },
    }
  }
}

/** Build an invalid-params failure naming the offending field. */
export function invalidParams(message: string, field?: string): A2AProtocolError {
  return new A2AProtocolError(
    A2A_ERROR.invalidParams,
    message,
    field === undefined ? undefined : { field },
  )
}

/** Build a method-not-found failure. */
export function methodNotFound(method: string): A2AProtocolError {
  return new A2AProtocolError(A2A_ERROR.methodNotFound, `Method not found: ${method}`, { method })
}

/** Build an internal failure with a peer-safe message. */
export function internalError(message = 'Internal error'): A2AProtocolError {
  return new A2AProtocolError(A2A_ERROR.internalError, message)
}

/**
 * Read a message from an arbitrary thrown value without leaking a stack.
 * @param error - value caught at a boundary.
 * @returns a short human-readable message.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'Unknown error'
}
