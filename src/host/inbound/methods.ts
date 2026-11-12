/**
 * A2A method normalization and the non-streaming handler table.
 *
 * Both protocol generations converge on {@link SendTaskInput}; the differences
 * (`tasks/send.id` vs `message.taskId`, `sessionId` vs `contextId`) end here.
 *
 * @module @local/dsh-a2a/inbound/methods
 */

import { randomUUID } from 'node:crypto'
import {
  A2A_ERROR,
  A2A_METHODS,
  isMessage,
  isPart,
  isRecord,
  type Message,
  type Task,
} from '../../shared/protocol.ts'
import { A2AProtocolError, invalidParams } from '../../shared/errors.ts'
import type { A2AService } from '../a2a-service.ts'
import type { RpcHandler } from '../http/jsonrpc.ts'
import type { SendTaskInput } from './task-types.ts'

/** Methods whose response is an SSE stream rather than one JSON value. */
const STREAMING_METHODS: ReadonlySet<string> = new Set([
  A2A_METHODS.streamMessage,
  A2A_METHODS.legacySendSubscribe,
  A2A_METHODS.resubscribeTask,
  // A2A 1.0 protoJSON names over JSON-RPC (see METHOD_ALIASES).
  'SendStreamingMessage',
  'SubscribeToTask',
])

/**
 * A2A 1.0 clients send the proto RPC names over JSON-RPC. Hermes and OpenClaw
 * both use these PascalCase names for the same operations as the slash-style
 * 0.3 methods; each alias is served by the canonical handler.
 */
const METHOD_ALIASES: Readonly<Record<string, string>> = {
  SendMessage: A2A_METHODS.sendMessage,
  SendStreamingMessage: A2A_METHODS.streamMessage,
  GetTask: A2A_METHODS.getTask,
  CancelTask: A2A_METHODS.cancelTask,
  SubscribeToTask: A2A_METHODS.resubscribeTask,
}

/**
 * Canonical handler name for one request method.
 *
 * @param method - method name as the peer sent it.
 * @returns the canonical 0.3-style name, or the input when it is not an alias.
 */
export function canonicalMethod(method: string): string {
  return METHOD_ALIASES[method] ?? method
}

/**
 * Whether a method owns its response as an SSE stream.
 *
 * @param method - JSON-RPC method name, canonical or 1.0 alias.
 * @returns true for `message/stream`, `tasks/sendSubscribe`, `tasks/resubscribe`,
 *   and their `SendStreamingMessage`/`SubscribeToTask` aliases.
 */
export function isStreamingMethod(method: string): boolean {
  return STREAMING_METHODS.has(method)
}

/**
 * Build the non-streaming method table.
 *
 * @param service - A2A capability that owns the task manager.
 * @returns handlers keyed by every non-streaming A2A method name.
 */
export function createMethodHandlers(service: A2AService): ReadonlyMap<string, RpcHandler> {
  const handlers = new Map<string, RpcHandler>()

  handlers.set(A2A_METHODS.sendMessage, async (params, _request, runtime) => (
    service.send(normalizeSend(params, 'continue'), runtime.peer)
  ))
  handlers.set(A2A_METHODS.legacySend, async (params, _request, runtime) => (
    service.send(normalizeSend(params, 'assign'), runtime.peer)
  ))
  handlers.set(A2A_METHODS.getTask, async (params) => {
    const { id, historyLength } = normalizeGet(params)
    return service.get(id, historyLength)
  })
  handlers.set(A2A_METHODS.cancelTask, async params => service.cancel(normalizeId(params)))

  const pushUnsupported: RpcHandler = async () => {
    throw new A2AProtocolError(A2A_ERROR.pushNotificationNotSupported, 'Push notifications are not supported by this agent')
  }
  for (const method of [
    A2A_METHODS.setPushConfig,
    A2A_METHODS.getPushConfig,
    A2A_METHODS.listPushConfigs,
    A2A_METHODS.deletePushConfig,
  ]) {
    handlers.set(method, pushUnsupported)
  }

  for (const [alias, canonical] of Object.entries(METHOD_ALIASES)) {
    const handler = handlers.get(canonical)
    if (handler !== undefined) handlers.set(alias, handler)
  }
  return handlers
}

/**
 * Normalize one streaming send request.
 *
 * @param method - `message/stream` or `tasks/sendSubscribe`.
 * @param params - raw JSON-RPC params.
 * @returns send input ready for the task manager.
 */
export function normalizeStreamingSend(method: string, params: Record<string, unknown>): SendTaskInput {
  return method === A2A_METHODS.legacySendSubscribe
    ? normalizeSend(params, 'assign')
    : normalizeSend(params, 'continue')
}

/**
 * Normalize `tasks/resubscribe` params.
 *
 * @param params - raw JSON-RPC params.
 * @returns the task id.
 */
export function normalizeResubscribe(params: Record<string, unknown>): string {
  return normalizeId(params)
}

/**
 * Normalize one send request.
 *
 * @param params - raw JSON-RPC params.
 * @param taskIdMode - `continue` for 0.3, `assign` for 0.2.
 * @returns normalized send input.
 * @throws {A2AProtocolError} for missing or contradictory fields.
 */
export function normalizeSend(params: Record<string, unknown>, taskIdMode: 'continue' | 'assign'): SendTaskInput {
  if (taskIdMode === 'assign') return normalizeLegacySend(params)

  const message = parseMessage(params.message, false)
  if (message.role !== 'user') throw invalidParams('message.role must be "user"', 'message.role')
  const configuration = parseConfiguration(params.configuration)
  return {
    message,
    taskIdMode,
    blocking: configuration.blocking,
    ...message.taskId === undefined ? {} : { taskId: message.taskId },
    ...message.contextId === undefined ? {} : { contextId: message.contextId },
    ...configuration.historyLength === undefined ? {} : { historyLength: configuration.historyLength },
  }
}

/** Normalize the 0.2 `tasks/send` shape. */
function normalizeLegacySend(params: Record<string, unknown>): SendTaskInput {
  const id = requireString(params.id, 'id')
  const message = parseMessage(params.message, true)
  if (message.role !== 'user') throw invalidParams('message.role must be "user"', 'message.role')
  if (message.taskId !== undefined && message.taskId !== id) {
    throw invalidParams('message.taskId must match id', 'message.taskId')
  }
  const sessionId = params.sessionId === undefined ? undefined : requireString(params.sessionId, 'sessionId')
  if (message.contextId !== undefined && sessionId !== undefined && message.contextId !== sessionId) {
    throw invalidParams('message.contextId must match sessionId', 'message.contextId')
  }
  if (params.pushNotification !== undefined) {
    throw new A2AProtocolError(A2A_ERROR.pushNotificationNotSupported, 'Push notifications are not supported')
  }
  const historyLength = params.historyLength === undefined ? undefined : parseHistoryLength(params.historyLength, 'historyLength')
  return {
    message,
    taskId: id,
    taskIdMode: 'assign',
    blocking: true,
    ...sessionId === undefined ? {} : { contextId: sessionId },
    ...historyLength === undefined ? {} : { historyLength },
  }
}

/** Parse one message, filling a generated id only for the 0.2 path. */
function parseMessage(value: unknown, generatedIdAllowed: boolean): Message {
  if (!isRecord(value)) throw invalidParams('message must be an object', 'message')
  const role = normalizeRole(value.role)
  if (role === undefined) {
    throw invalidParams('message.role must be "user" or "agent" (or its 1.0 enum ROLE_USER/ROLE_AGENT)', 'message.role')
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw invalidParams('message.parts must be a non-empty array', 'message.parts')
  }
  for (const [index, part] of value.parts.entries()) {
    if (!isPart(part)) throw invalidParams(`message.parts[${String(index)}] is not a supported part`, `message.parts[${String(index)}]`)
  }
  const messageId = typeof value.messageId === 'string' && value.messageId.length > 0
    ? value.messageId
    : generatedIdAllowed ? randomUUID() : undefined
  if (messageId === undefined) throw invalidParams('message.messageId is required', 'message.messageId')

  const message: Message = {
    kind: 'message',
    messageId,
    role,
    parts: value.parts as Message['parts'],
    ...value.contextId === undefined ? {} : { contextId: requireString(value.contextId, 'message.contextId') },
    ...value.taskId === undefined ? {} : { taskId: requireString(value.taskId, 'message.taskId') },
    ...value.referenceTaskIds === undefined ? {} : { referenceTaskIds: parseStringArray(value.referenceTaskIds, 'message.referenceTaskIds') },
    ...value.metadata === undefined ? {} : { metadata: isRecord(value.metadata) ? value.metadata : {} },
  }
  if (!isMessage(message)) throw invalidParams('message is not a valid A2A message', 'message')
  return message
}

/**
 * Normalize the protocol-version-dependent role spelling.
 *
 * 0.3 sends `user`/`agent`; A2A 1.0 protoJSON sends `ROLE_USER`/`ROLE_AGENT`.
 *
 * @param value - `message.role`, absent in the 0.2 legacy shape.
 * @returns the canonical role, or undefined for an unsupported value.
 */
function normalizeRole(value: unknown): 'user' | 'agent' | undefined {
  if (value === undefined) return 'user'
  if (value === 'user' || value === 'ROLE_USER') return 'user'
  if (value === 'agent' || value === 'ROLE_AGENT') return 'agent'
  return undefined
}

/** Parse send configuration. */
function parseConfiguration(value: unknown): { blocking: boolean; historyLength?: number } {
  if (value === undefined) return { blocking: true }
  if (!isRecord(value)) throw invalidParams('configuration must be an object', 'configuration')
  if (value.pushNotificationConfig !== undefined) {
    throw new A2AProtocolError(A2A_ERROR.pushNotificationNotSupported, 'Push notifications are not supported')
  }
  if (value.blocking !== undefined && typeof value.blocking !== 'boolean') {
    throw invalidParams('configuration.blocking must be a boolean', 'configuration.blocking')
  }
  if (value.returnImmediately !== undefined && typeof value.returnImmediately !== 'boolean') {
    throw invalidParams('configuration.returnImmediately must be a boolean', 'configuration.returnImmediately')
  }
  const historyLength = value.historyLength === undefined
    ? undefined
    : parseHistoryLength(value.historyLength, 'configuration.historyLength')
  // 1.0 protoJSON clients ask for an immediate acknowledgement with
  // `returnImmediately: true` and then poll `GetTask`. The task is answered
  // inside one blocking response instead: that is what a one-shot client
  // consumes, and polling remains available for peers that do it.
  const blocking = value.blocking !== false
  return {
    blocking,
    ...historyLength === undefined ? {} : { historyLength },
  }
}

/** Parse `tasks/get` params. */
function normalizeGet(params: Record<string, unknown>): { id: string; historyLength?: number } {
  const id = normalizeId(params)
  const historyLength = params.historyLength === undefined
    ? undefined
    : parseHistoryLength(params.historyLength, 'historyLength')
  return { id, ...historyLength === undefined ? {} : { historyLength } }
}

/** Parse a task id. */
function normalizeId(params: Record<string, unknown>): string {
  return requireString(params.id, 'id')
}

/** Require one bounded string field. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`${field} must be a non-empty string`, field)
  }
  if (value.length > 256) throw invalidParams(`${field} must be at most 256 characters`, field)
  return value
}

/** Parse a non-negative history length. */
function parseHistoryLength(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000) {
    throw invalidParams(`${field} must be an integer between 0 and 1000`, field)
  }
  return value
}

/** Parse a string array. */
function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw invalidParams(`${field} must be an array of strings`, field)
  }
  return value
}
