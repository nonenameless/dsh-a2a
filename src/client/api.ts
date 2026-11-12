/**
 * Typed browser client for the same-origin A2A admin API.
 *
 * The panel never receives a token; responses only say whether one is stored.
 *
 * @module @local/dsh-a2a/client/api
 */

/** One node row in the admin snapshot. */
export interface AdminNode {
  id: string
  name: string
  url: string
  enabled: boolean
  autoDiscover: boolean
  authMode: 'none' | 'bearer'
  tokenEnv: string
  card?: {
    name: string
    description: string
    version: string
    skills: Array<{ id: string; name: string; description: string }>
  }
  error?: string
  checkedAt?: string
  skills: number
  tools: string[]
}

/** One activity entry. */
export interface AdminLogEntry {
  seq: number
  time: string
  direction: 'inbound' | 'outbound' | 'system'
  level: 'info' | 'warn' | 'error'
  message: string
  taskId?: string
  contextId?: string
  peer?: string
  state?: string
  durationMs?: number
}

/** Complete admin snapshot. */
export interface AdminState {
  plugin: { name: string; version: string; protocolVersion: string }
  server: {
    enabled: boolean
    origin: string
    rpcPath: string
    rpcUrl: string
    agentCardPath: string
    agentCardAliases: string[]
    authMode: 'none' | 'bearer'
    tokenConfigured: boolean
    peers: Array<{ id: string; tokenConfigured: boolean }>
    streaming: boolean
    pushNotifications: boolean
    startedAt: string
  }
  client: {
    enabled: boolean
    toolPrefix: string
    discoverOnStart: boolean
    allowPrivateHosts: boolean
    nodeCount: number
    enabledNodeCount: number
    discoveredNodes: number
    registeredTools: number
    nodes: AdminNode[]
  }
  tasks: { active: number; total: number; byState: Record<string, number> }
  logs: { capacity: number; retained: number; recent: AdminLogEntry[] }
}

/** Editable node fields. */
export interface NodeInput {
  id: string
  name: string
  url: string
  enabled: boolean
  autoDiscover: boolean
  auth: { mode: 'none' | 'bearer'; tokenEnv: string }
}

/**
 * Read the admin snapshot.
 *
 * @param signal - abort signal for unmount.
 * @returns the normalized state.
 */
export async function fetchState(signal?: AbortSignal): Promise<AdminState> {
  const response = await fetch('/a2a/admin/state', {
    method: 'GET',
    headers: { accept: 'application/json' },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(await errorText(response))
  return await response.json() as AdminState
}

/**
 * Add or replace one node.
 *
 * @param node - node fields.
 * @param token - optional bearer token; omit to leave the stored token untouched.
 */
export async function saveNode(node: NodeInput, token?: string): Promise<void> {
  await post('/a2a/admin/nodes', {
    node,
    ...token === undefined || token.length === 0 ? {} : { token },
  })
}

/**
 * Remove one node and its stored token.
 *
 * @param id - node id.
 */
export async function deleteNode(id: string): Promise<void> {
  await post('/a2a/admin/nodes/delete', { id })
}

/**
 * Re-discover one node and rebuild its tools.
 *
 * @param id - node id.
 */
export async function refreshNode(id: string): Promise<void> {
  await post('/a2a/admin/nodes/refresh', { id })
}

/**
 * Store or clear the inbound bearer token.
 *
 * @param token - new token; empty clears it.
 */
export async function saveInboundToken(token: string): Promise<void> {
  await post('/a2a/admin/inbound-token', { token })
}

/**
 * Store or clear one inbound peer's bearer token.
 *
 * @param id - configured peer id.
 * @param token - new token; empty clears it.
 */
export async function savePeerToken(id: string, token: string): Promise<void> {
  await post('/a2a/admin/peer-token', { id, token })
}

/**
 * Store or clear one node's bearer token.
 *
 * @param id - node id.
 * @param token - new token; empty clears it.
 */
export async function saveNodeToken(id: string, token: string): Promise<void> {
  await post('/a2a/admin/node-token', { id, token })
}

/** POST one JSON body and normalize server failures. */
async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await errorText(response))
  const value = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  if (value !== undefined && typeof value.error === 'string') throw new Error(value.error)
}

/** Read a short error message from a failed response. */
async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (text.length === 0) return `Request failed: HTTP ${String(response.status)}`
  try {
    const value = JSON.parse(text) as { error?: unknown }
    if (typeof value.error === 'string') return value.error
  } catch {
    // Fall through to the raw body.
  }
  return text
}
