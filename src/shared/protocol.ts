/**
 * Agent2Agent (A2A) wire vocabulary shared by the Host and Client faces.
 *
 * The plugin targets A2A protocol 0.3.0 and also accepts the 0.2.x method names
 * (`tasks/send`, `tasks/sendSubscribe`) because deployed peers still use them.
 * These declarations are deliberately dependency-free: the protocol surface is
 * small, and owning it keeps the bundle installable without an SDK whose
 * transport (Express, its own JSON-RPC layer) would duplicate DSH's web server.
 *
 * Nothing here performs I/O or validation of untrusted values beyond the type
 * guards at the bottom. Wire input is validated again in `host/http/jsonrpc.ts`.
 *
 * @module @local/dsh-a2a/protocol
 */

/** Canonical protocol version advertised in the Agent Card. */
export const A2A_PROTOCOL_VERSION = '0.3.0'

/** Last protocol generation whose `tasks/*` method names this server still accepts. */
export const A2A_LEGACY_PROTOCOL_VERSION = '0.2.6'

/** Media types the built-in text bridge can carry. */
export const TEXT_MEDIA_TYPE = 'text/plain'
export const JSON_MEDIA_TYPE = 'application/json'

/** JSON-RPC method names, canonical first and legacy aliases second. */
export const A2A_METHODS = {
  /** 0.3: send one message and wait for the Task or Message result. */
  sendMessage: 'message/send',
  /** 0.3: send one message and subscribe to the Task event stream. */
  streamMessage: 'message/stream',
  /** Shared by 0.2 and 0.3. */
  getTask: 'tasks/get',
  /** Shared by 0.2 and 0.3. */
  cancelTask: 'tasks/cancel',
  /** Shared by 0.2 and 0.3. */
  resubscribeTask: 'tasks/resubscribe',
  /** Shared by 0.2 and 0.3. */
  setPushConfig: 'tasks/pushNotificationConfig/set',
  /** Shared by 0.2 and 0.3. */
  getPushConfig: 'tasks/pushNotificationConfig/get',
  /** Shared by 0.2 and 0.3. */
  listPushConfigs: 'tasks/pushNotificationConfig/list',
  /** Shared by 0.2 and 0.3. */
  deletePushConfig: 'tasks/pushNotificationConfig/delete',
  /** 0.2: send one message and wait. */
  legacySend: 'tasks/send',
  /** 0.2: send one message and stream. */
  legacySendSubscribe: 'tasks/sendSubscribe',
} as const

/** Canonical JSON-RPC 2.0 error codes plus the A2A reserved range. */
export const A2A_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  authenticatedExtendedCardNotConfigured: -32007,
} as const

/** JSON-RPC id: a string, a number, or null for notifications. */
export type JsonRpcId = string | number | null

/** One JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

/** One JSON-RPC 2.0 success envelope. */
export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: T
}

/** One JSON-RPC 2.0 error envelope. */
export interface JsonRpcError {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

/** Any JSON-RPC 2.0 response envelope. */
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError

/** Task lifecycle states. The six core states are always available; the last three are 0.3 additions. */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown'

/** States from which no further transition is accepted. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'canceled',
  'failed',
  'rejected',
])

/** Whether a task state is terminal. */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state)
}

/** A plain text part. */
export interface TextPart {
  kind: 'text'
  text: string
  metadata?: Record<string, unknown>
}

/** A file part. Exactly one of `bytes` (base64) or `uri` is present. */
export interface FilePart {
  kind: 'file'
  file: {
    name?: string
    mimeType?: string
    bytes?: string
    uri?: string
  }
  metadata?: Record<string, unknown>
}

/** A structured JSON part. */
export interface DataPart {
  kind: 'data'
  data: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/** One content part. `kind` is optional only to admit 0.2-era `type` discriminators. */
export type Part = TextPart | FilePart | DataPart

/** One conversation message. */
export interface Message {
  kind?: 'message'
  messageId: string
  role: 'user' | 'agent'
  parts: Part[]
  contextId?: string
  taskId?: string
  referenceTaskIds?: string[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

/** One produced artifact. */
export interface Artifact {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

/** Current status of one task. */
export interface TaskStatus {
  state: TaskState
  message?: Message
  timestamp?: string
}

/** Durable task value returned by send/get/cancel. */
export interface Task {
  kind?: 'task'
  id: string
  contextId: string
  status: TaskStatus
  history?: Message[]
  artifacts?: Artifact[]
  metadata?: Record<string, unknown>
}

/** Streaming status notification. */
export interface TaskStatusUpdateEvent {
  kind: 'status-update'
  taskId: string
  contextId: string
  status: TaskStatus
  final: boolean
  metadata?: Record<string, unknown>
}

/** Streaming artifact notification. */
export interface TaskArtifactUpdateEvent {
  kind: 'artifact-update'
  taskId: string
  contextId: string
  artifact: Artifact
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

/** Any event delivered on a streaming response. */
export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent

/** Push notification registration. */
export interface PushNotificationConfig {
  id?: string
  url: string
  token?: string
  authentication?: {
    schemes: string[]
    credentials?: string
  }
}

/** Task-scoped push notification configuration. */
export interface TaskPushNotificationConfig {
  taskId?: string
  pushNotificationConfig: PushNotificationConfig
}

/** Optional send controls accepted by both protocol generations. */
export interface MessageSendConfiguration {
  acceptedOutputModes?: string[]
  historyLength?: number
  pushNotificationConfig?: PushNotificationConfig
  /** 0.3: when false, return as soon as the task is queued instead of waiting for a terminal state. */
  blocking?: boolean
}

/** Params for `message/send` and `message/stream`. */
export interface MessageSendParams {
  message: Message
  configuration?: MessageSendConfiguration
  metadata?: Record<string, unknown>
}

/** Params for `tasks/get`. */
export interface TaskQueryParams {
  id: string
  historyLength?: number
  metadata?: Record<string, unknown>
}

/** Params for `tasks/cancel`, `tasks/resubscribe`, and push config reads. */
export interface TaskIdParams {
  id: string
  metadata?: Record<string, unknown>
}

/** Params for the 0.2 `tasks/send` and `tasks/sendSubscribe` methods. */
export interface LegacyTaskSendParams {
  id: string
  sessionId?: string
  message: Message
  pushNotification?: PushNotificationConfig
  historyLength?: number
  metadata?: Record<string, unknown>
}

/** Agent capability flags. */
export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
  extensions?: Array<{
    uri: string
    description?: string
    required?: boolean
    params?: Record<string, unknown>
  }>
}

/** One skill advertised by an agent. */
export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  security?: Array<Record<string, string[]>>
}

/** One transport interface advertised by an agent. */
export interface AgentInterface {
  url: string
  transport?: string
  protocolBinding?: string
  protocolVersion?: string
}

/** HTTP bearer, API key, OAuth2, or OIDC security scheme. */
export type SecurityScheme =
  | { type: 'http'; scheme: string; bearerFormat?: string; description?: string }
  | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string; description?: string }
  | {
    type: 'oauth2'
    description?: string
    flows: Record<string, { authorizationUrl?: string; tokenUrl?: string; scopes?: Record<string, string> }>
  }
  | { type: 'openIdConnect'; openIdConnectUrl: string; description?: string }

/** The discovery document served at `/.well-known/agent.json`. */
export interface AgentCard {
  protocolVersion?: string
  name: string
  description: string
  url: string
  preferredTransport?: string
  supportedInterfaces?: AgentInterface[]
  additionalInterfaces?: AgentInterface[]
  provider?: { organization: string; url?: string }
  iconUrl?: string
  version: string
  documentationUrl?: string
  capabilities: AgentCapabilities
  securitySchemes?: Record<string, SecurityScheme>
  security?: Array<Record<string, string[]>>
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
  supportsAuthenticatedExtendedCard?: boolean
  signatures?: Array<{ protected: string; signature: string; header?: Record<string, unknown> }>
}

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown value to a JSON-RPC request envelope. */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false
  if (value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0) return false
  const id = value.id
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
}

/** Read the discriminator of a part, accepting the 0.2 `type` spelling. */
export function partKind(part: unknown): 'text' | 'file' | 'data' | undefined {
  if (!isRecord(part)) return undefined
  const kind = part.kind ?? part.type
  if (kind === 'text' || kind === 'file' || kind === 'data') return kind
  // A2A 1.0 proto-JSON parts omit the discriminator and carry `text`/`data`/`file`.
  if (typeof part.text === 'string') return 'text'
  if (part.data !== undefined) return 'data'
  if (isRecord(part.file)) return 'file'
  return undefined
}

/** Narrow an unknown value to a part. */
export function isPart(value: unknown): value is Part {
  const kind = partKind(value)
  if (kind === 'text') return typeof (value as Record<string, unknown>).text === 'string'
  if (kind === 'data') return isRecord((value as Record<string, unknown>).data)
  if (kind === 'file') return isRecord((value as Record<string, unknown>).file)
  return false
}

/** Narrow an unknown value to a message. */
export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false
  if (typeof value.messageId !== 'string' || value.messageId.length === 0) return false
  if (value.role !== 'user' && value.role !== 'agent') return false
  if (!Array.isArray(value.parts) || value.parts.length === 0) return false
  return value.parts.every(isPart)
}

/** Narrow an unknown value to a task. */
export function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.contextId !== 'string') return false
  if (!isRecord(value.status) || typeof value.status.state !== 'string') return false
  return Array.isArray(value.history) || value.history === undefined
}

/** Extract the concatenated text of all text parts. */
export function textOfParts(parts: readonly Part[]): string {
  return parts
    .flatMap(part => partKind(part) === 'text' ? [(part as TextPart).text] : [])
    .join('\n')
}

/** Build one text part. */
export function textPart(text: string): TextPart {
  return { kind: 'text', text }
}

/** Build one data part. */
export function dataPart(data: Record<string, unknown>): DataPart {
  return { kind: 'data', data }
}

/** Build one agent message with a fresh caller-supplied identity. */
export function agentMessage(messageId: string, parts: Part[], contextId?: string, taskId?: string): Message {
  return {
    kind: 'message',
    messageId,
    role: 'agent',
    parts,
    ...contextId === undefined ? {} : { contextId },
    ...taskId === undefined ? {} : { taskId },
  }
}
