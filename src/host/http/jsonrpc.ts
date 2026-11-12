/**
 * JSON-RPC 2.0 envelope validation and method dispatch.
 *
 * Envelope failures (parse errors, bad ids, batches) are separated from method
 * failures so the route layer can choose the right HTTP status. Valid
 * envelopes always answer 200 with either `result` or `error`, including
 * method-not-found.
 *
 * @module @local/dsh-a2a/http/jsonrpc
 */

import {
  A2A_ERROR,
  A2A_METHODS,
  isJsonRpcRequest,
  isRecord,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../../shared/protocol.ts'
import { A2AProtocolError, internalError, invalidParams, methodNotFound } from '../../shared/errors.ts'
import type { Config } from '../config.ts'
import type { A2AService } from '../a2a-service.ts'

/** Logger surface used by the dispatcher. */
export interface RpcLogger {
  warn(message: string, error?: unknown): void
}

/** Runtime values one method handler may read. */
export interface RpcRuntime {
  config: Config
  service: A2AService
  logger: RpcLogger
  /** Method handlers installed by later steps; empty until task execution lands. */
  methods: ReadonlyMap<string, RpcHandler>
  /** Configured inbound peer whose bearer token admitted this request. */
  peer?: string | undefined
}

/** One method implementation. */
export type RpcHandler = (
  params: Record<string, unknown>,
  request: JsonRpcRequest,
  runtime: RpcRuntime,
) => Promise<unknown>

/** Every method name this server knows, including 0.2 aliases. */
const KNOWN_METHODS: ReadonlySet<string> = new Set(Object.values(A2A_METHODS))

/**
 * Validate one parsed request body as a JSON-RPC 2.0 request.
 *
 * @param value - parsed JSON value.
 * @returns the validated request envelope.
 * @throws {A2AProtocolError} with `-32600` for an invalid envelope.
 */
export function validateJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (Array.isArray(value)) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'Batch requests are not supported')
  }
  if (!isRecord(value)) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'Request must be a JSON object')
  }
  if (value.jsonrpc !== '2.0') {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'jsonrpc must be "2.0"')
  }
  if (typeof value.method !== 'string' || value.method.length === 0) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'method must be a non-empty string')
  }
  if (!('id' in value)) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'id is required for A2A requests')
  }
  const id = value.id
  if (id === null) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'id must not be null')
  }
  if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'id must be a string or a finite number')
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw invalidParams('params must be an object when present', 'params')
  }
  if (!isJsonRpcRequest(value)) {
    throw new A2AProtocolError(A2A_ERROR.invalidRequest, 'Request is not a valid JSON-RPC 2.0 envelope')
  }
  return {
    jsonrpc: '2.0',
    id,
    method: value.method,
    ...value.params === undefined ? {} : { params: value.params },
  }
}

/**
 * Extract a best-effort id from a malformed value so an error response can
 * still be correlated when the id itself is valid.
 *
 * @param value - parsed request body.
 * @returns the id, or null.
 */
export function idOf(value: unknown): JsonRpcId {
  if (!isRecord(value)) return null
  const id = value.id
  if (typeof id === 'string') return id
  if (typeof id === 'number' && Number.isFinite(id)) return id
  return null
}

/**
 * Dispatch one validated request.
 *
 * @param request - validated JSON-RPC request.
 * @param runtime - handlers plus the resolved service context.
 * @returns a success or error envelope; this function does not throw.
 */
export async function dispatchJsonRpc(
  request: JsonRpcRequest,
  runtime: RpcRuntime,
): Promise<JsonRpcResponse> {
  const handler = runtime.methods.get(request.method)
  if (handler !== undefined) {
    try {
      const result = await handler((request.params ?? {}) as Record<string, unknown>, request, runtime)
      return { jsonrpc: '2.0', id: request.id, result }
    } catch (error: unknown) {
      if (error instanceof A2AProtocolError) return error.toJsonRpc(request.id)
      runtime.logger.warn(`dsh-a2a: method ${request.method} failed`, error)
      return internalError().toJsonRpc(request.id)
    }
  }

  if (KNOWN_METHODS.has(request.method)) {
    return new A2AProtocolError(
      A2A_ERROR.unsupportedOperation,
      `Method ${request.method} is not implemented in this build`,
      { method: request.method },
    ).toJsonRpc(request.id)
  }

  return methodNotFound(request.method).toJsonRpc(request.id)
}

/**
 * Project a failure into a JSON-RPC error envelope.
 *
 * @param id - request id to echo.
 * @param error - protocol fault or unexpected failure.
 * @param logger - optional logger for unexpected failures.
 * @returns an error envelope.
 */
export function toErrorResponse(id: JsonRpcId, error: unknown, logger?: RpcLogger): JsonRpcError {
  if (error instanceof A2AProtocolError) return error.toJsonRpc(id)
  logger?.warn('dsh-a2a: unhandled request failure', error)
  return internalError().toJsonRpc(id)
}
