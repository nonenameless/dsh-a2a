/**
 * Outbound A2A JSON-RPC client used by generated skill tools.
 *
 * Discovery is separate (`agent-card.ts`); this module only sends one task and
 * projects the response. It prefers 0.3 `message/send` and falls back to the
 * 0.2 `tasks/send` shape based on the peer's advertised protocol version.
 *
 * @module @local/dsh-a2a/outbound/rpc-client
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, NodeConfig } from '../config.ts'
import type { CredentialsService } from '../dsh.ts'
import type { LogBus } from '../admin/log-bus.ts'
import {
  A2A_METHODS,
  isMessage,
  isRecord,
  isTask,
  partKind,
  type AgentCard,
  type Message,
  type Task,
} from '../../shared/protocol.ts'
import { messageOf } from '../../shared/errors.ts'
import { NODE_CREDENTIAL_PREFIX } from '../../shared/constants.ts'
import { isEventStreamContentType, readBoundedText } from '../http/body.ts'

/** Largest accepted JSON-RPC response body for one blocking call. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** A2A 1.0 proto RPC name for the same send operation. */
const PROTO_SEND_METHOD = 'SendMessage'

/** JSON-RPC method-not-found code. */
const METHOD_NOT_FOUND = -32601

/**
 * Whether a JSON-RPC response reports an unknown method, i.e. the peer speaks
 * the other method-name convention.
 *
 * @param body - parsed JSON-RPC response.
 * @returns true for a `-32601` error.
 */
function isUnknownMethod(body: Record<string, unknown>): boolean {
  const error = body.error
  return isRecord(error) && error.code === METHOD_NOT_FOUND
}

/** Result of one remote task, projected onto a tool-friendly value. */
export interface RemoteTaskResult {
  ok: boolean
  state: string
  taskId?: string
  contextId?: string
  text: string
  error?: string
}

/** Input of one outbound call. */
export interface RemoteSendInput {
  text: string
  taskId?: string
  contextId?: string
}

/** JSON-RPC client with per-node bearer credentials. */
export class A2AClient {
  /**
   * @param ctx - plugin context used for credentials and logging.
   * @param config - resolved plugin configuration.
   * @param logs - panel activity bus.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logs: LogBus,
  ) {}

  /**
   * Send one task to a remote agent.
   *
   * @param node - configured node.
   * @param card - discovered card describing the endpoint and protocol.
   * @param input - task text and optional continuation identity.
   * @param signal - caller cancellation.
   * @returns a projected result; task failures are values, transport failures throw.
   */
  async send(
    node: NodeConfig,
    card: AgentCard,
    input: RemoteSendInput,
    signal: AbortSignal,
  ): Promise<RemoteTaskResult> {
    const startedAt = Date.now()
    const token = node.auth.mode === 'bearer' ? await this.resolveToken(node) : undefined
    if (node.auth.mode === 'bearer' && token === undefined) {
      throw new Error(`No bearer token is configured for node ${node.id}`)
    }

    const modern = isModernProtocol(card.protocolVersion)
    const v1 = isV1Protocol(card.protocolVersion)
    const messageId = randomUUID()
    const message: Message = {
      kind: 'message',
      messageId,
      role: 'user',
      parts: [{ kind: 'text', text: input.text }],
      ...input.contextId === undefined ? {} : { contextId: input.contextId },
      ...input.taskId === undefined ? {} : { taskId: input.taskId },
    }
    // A2A 1.0 proto-JSON uses role strings and parts without a discriminator.
    const v1Message = {
      messageId,
      role: 'user',
      parts: [{ text: input.text }],
      ...input.contextId === undefined ? {} : { contextId: input.contextId },
      ...input.taskId === undefined ? {} : { taskId: input.taskId },
    }
    const params = modern
      ? { message: v1 ? v1Message : message, configuration: v1 ? {} : { blocking: true } }
      : {
        id: input.taskId ?? randomUUID(),
        ...input.contextId === undefined ? {} : { sessionId: input.contextId },
        message,
      }

    const requestId = randomUUID()
    const method = modern ? A2A_METHODS.sendMessage : A2A_METHODS.legacySend

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('A2A request timed out')) }, this.config.client.requestTimeoutMs)
    timer.unref?.()
    const onAbort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })

    /** One JSON-RPC exchange with the peer. */
    const attempt = async (methodName: string): Promise<Record<string, unknown>> => {
      const payload = { jsonrpc: '2.0', id: requestId, method: methodName, params }
      const response = await fetch(card.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...token === undefined ? {} : { authorization: `Bearer ${token}` },
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Remote agent redirected the JSON-RPC call: HTTP ${String(response.status)}`)
      }
      if (!response.ok) throw new Error(`Remote agent returned HTTP ${String(response.status)}`)
      // A peer that answers a blocking send with an event stream never closes
      // its body; reading it would buffer until the timeout or the heap runs out.
      if (isEventStreamContentType(response.headers.get('content-type'))) {
        throw new Error('Remote agent answered a blocking call with an event stream; its task result cannot be read')
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES)
      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        throw new Error('Remote agent returned a body that is not JSON')
      }
      if (!isRecord(body)) throw new Error('Remote agent returned a non-object JSON-RPC response')
      return body
    }

    try {
      let body = await attempt(method)
      // A2A 1.0 peers (OpenClaw, Hermes) also implement the proto RPC names over
      // JSON-RPC; a 0.3-style client reaches them only through this fallback.
      if (modern && isUnknownMethod(body)) body = await attempt(PROTO_SEND_METHOD)

      if (isRecord(body.error)) {
        const code = typeof body.error.code === 'number' ? body.error.code : -32603
        const message = typeof body.error.message === 'string' ? body.error.message : 'Unknown remote error'
        throw new Error(`Remote A2A error ${String(code)}: ${message}`)
      }
      if (!('result' in body)) throw new Error('Remote agent returned no JSON-RPC result')
      const result = projectResult(body.result)

      this.logs.record({
        direction: 'outbound',
        level: result.ok ? 'info' : 'warn',
        peer: card.name,
        state: result.state,
        message: result.ok ? `Task ${result.state}` : `Task ${result.state}: ${result.error ?? 'failed'}`,
        ...result.taskId === undefined ? {} : { taskId: result.taskId },
        ...result.contextId === undefined ? {} : { contextId: result.contextId },
        durationMs: Date.now() - startedAt,
      })
      return result
    } catch (error: unknown) {
      this.logs.record({
        direction: 'outbound',
        level: 'error',
        peer: node.name,
        message: messageOf(error),
        durationMs: Date.now() - startedAt,
      })
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Resolve a node token from the credential store, then its environment variable. */
  private async resolveToken(node: NodeConfig): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials') as CredentialsService | undefined
    if (credentials !== undefined) {
      try {
        const record = await credentials.readRecord(`${NODE_CREDENTIAL_PREFIX}${node.id}`)
        if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) return record.key
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-a2a: could not read credentials for node ${node.id}`, error)
      }
    }
    const name = node.auth.tokenEnv
    if (name.length === 0) return undefined
    const value = process.env[name]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }
}

/**
 * Whether a peer protocol version supports the 0.3 method names.
 *
 * @param version - advertised protocol version, or undefined for legacy peers.
 * @returns true for 0.3 and later.
 */
export function isModernProtocol(version: string | undefined): boolean {
  if (version === undefined) return false
  const [majorText, minorText] = version.split('.', 2)
  const major = Number(majorText)
  const minor = Number(minorText)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 0 || minor >= 3
}

/**
 * Whether a peer uses the A2A 1.0 proto-JSON shape (role/state enums, wrapped
 * `result.task`, and parts without `kind`).
 *
 * @param version - advertised protocol version.
 * @returns true for 1.x.
 */
export function isV1Protocol(version: string | undefined): boolean {
  if (version === undefined) return false
  const major = Number(version.split('.', 1)[0])
  return Number.isFinite(major) && major >= 1
}

/** Project a Task or Message result onto the tool value. */
function projectResult(value: unknown): RemoteTaskResult {
  let candidate = value
  if (isRecord(candidate) && isRecord(candidate.task)) candidate = candidate.task
  else if (isRecord(candidate) && isRecord(candidate.message)) candidate = candidate.message
  if (!isRecord(candidate)) throw new Error('Remote result must be a Task or Message object')
  if (isMessage(candidate)) {
    return { ok: true, state: 'completed', text: textOfUnknownParts(candidate.parts) }
  }
  if (typeof candidate.messageId === 'string' && Array.isArray(candidate.parts)) {
    return { ok: true, state: 'completed', text: textOfUnknownParts(candidate.parts) }
  }
  if (!isTask(candidate)) throw new Error('Remote result is not a valid Task')

  const task = candidate
  const state = normalizeState(task.status.state)
  const text = taskText(task)
  const terminal = state === 'completed'
  const accepted = state === 'input-required'
  const error = terminal || accepted ? undefined : text.length > 0 ? text : `Remote task ended as ${state}`
  return {
    ok: terminal || accepted,
    state,
    taskId: task.id,
    ...typeof task.contextId === 'string' ? { contextId: task.contextId } : {},
    text,
    ...error === undefined ? {} : { error },
  }
}

/** Map proto enum task states onto the canonical A2A names. */
function normalizeState(state: string): string {
  if (!state.startsWith('TASK_STATE_')) return state
  return state.slice('TASK_STATE_'.length).toLowerCase().replaceAll('_', '-')
}

/** Concatenate artifact text, then status message, then the last agent history message. */
function taskText(task: Task): string {
  const artifactText = textOfUnknownParts(
    (task.artifacts ?? []).flatMap(artifact => artifact.parts),
  )
  if (artifactText.length > 0) return artifactText
  if (task.status.message !== undefined) {
    const statusText = textOfUnknownParts(task.status.message.parts)
    if (statusText.length > 0) return statusText
  }
  const history = task.history ?? []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message !== undefined && (message.role === 'agent' || String(message.role) === 'ROLE_AGENT')) {
      return textOfUnknownParts(message.parts)
    }
  }
  return ''
}

/** Read text from a wire part list that may use either part shape. */
function textOfUnknownParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts.flatMap(part => partKind(part) === 'text' ? [(part as { text: string }).text] : []).join('\n')
}


