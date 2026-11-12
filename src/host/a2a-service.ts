/**
 * The `ctx.a2a` capability published by this bundle.
 *
 * It owns the read-only facts shared by the HTTP routes and the settings
 * panel: the resolved configuration, the local Agent Card, the public origin,
 * and the authentication state. Task and node state join this service in the
 * next implementation steps behind the same accessor style.
 *
 * @module @local/dsh-a2a/a2a-service
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type Config, type NodeConfig } from './config.ts'
import type { ConfigEditorService, CredentialsService, WebServerService } from './dsh.ts'
import type { AgentCardDocument } from './outbound/agent-card.ts'
import { buildAgentCard, joinUrl } from './outbound/agent-card.ts'
import { resolveInboundToken, resolvePeerToken } from './http/auth.ts'
import { INBOUND_CREDENTIAL_KEY, NODE_CREDENTIAL_PREFIX, PEER_CREDENTIAL_PREFIX, PLUGIN_NAME } from '../shared/constants.ts'
import { A2A_PROTOCOL_VERSION, type JsonRpcId, type Task, type TaskEvent } from '../shared/protocol.ts'
import { AgentExecutor } from './inbound/agent-executor.ts'
import { TaskManager } from './inbound/task-manager.ts'
import { openSse } from './http/sse.ts'
import type { SendTaskInput } from './inbound/task-types.ts'
import { LogBus, type LogEntry } from './admin/log-bus.ts'
import { NodeRegistry, type NodeRuntime } from './outbound/node-registry.ts'
import { A2AClient } from './outbound/rpc-client.ts'
import { ToolRegistrar } from './outbound/tool-registrar.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local A2A capability: card, origin, authentication state, and admin snapshot. */
    a2a: A2AService
  }
}

/** Read-only server facts for the settings panel. */
export interface A2AServerState {
  enabled: boolean
  origin: string
  rpcPath: string
  rpcUrl: string
  agentCardPath: string
  agentCardAliases: string[]
  authMode: 'none' | 'bearer'
  /** True when bearer mode has a resolvable token, or when auth is disabled. */
  tokenConfigured: boolean
  /** Configured inbound peers and whether each has a token. */
  peers: Array<{ id: string; tokenConfigured: boolean }>
  streaming: boolean
  pushNotifications: boolean
  startedAt: string
}

/** Read-only client facts for the settings panel. */
export interface A2AClientState {
  enabled: boolean
  toolPrefix: string
  discoverOnStart: boolean
  allowPrivateHosts: boolean
  nodeCount: number
  enabledNodeCount: number
  discoveredNodes: number
  registeredTools: number
  nodes: NodeRuntime[]
}

/** Task counters; filled by the task manager in the next step. */
export interface A2ATaskState {
  active: number
  total: number
  byState: Record<string, number>
}

/** Log retention facts; filled by the admin event bus in a later step. */
export interface A2ALogState {
  capacity: number
  retained: number
  recent: LogEntry[]
}

/** Complete snapshot returned by `GET /a2a/admin/state`. */
export interface A2AAdminState {
  plugin: { name: string; version: string; protocolVersion: string }
  server: A2AServerState
  client: A2AClientState
  tasks: A2ATaskState
  logs: A2ALogState
}

/** Public liveness document returned by `GET /a2a/health`. */
export interface A2AHealth {
  ok: true
  plugin: string
  version: string
  protocolVersion: string
  serverEnabled: boolean
  authMode: 'none' | 'bearer'
  streaming: boolean
  startedAt: string
}

/** Live A2A capability held for the plugin's lifetime. */
export class A2AService {
  /** Activation timestamp shown by the panel. */
  readonly startedAt = new Date().toISOString()

  private warnedMissingToken = false
  private taskManager: TaskManager | undefined
  private registry: NodeRegistry | undefined
  private registrar: ToolRegistrar | undefined
  private outboundStarted = false

  private readonly logs: LogBus

  /**
   * @param ctx - owning plugin context.
   * @param config - resolved configuration.
   */
  constructor(
    private readonly ctx: Context,
    readonly config: Config,
  ) {
    this.logs = new LogBus(config.logs.capacity)
  }

  /**
   * Public base URL: the configured `publicUrl`, otherwise the bound origin.
   * @returns a URL without a trailing slash, or an empty string before the web server binds.
   */
  origin(): string {
    if (this.config.server.publicUrl.length > 0) return this.config.server.publicUrl
    const web = this.ctx.get('webServer') as WebServerService | undefined
    return web?.getOrigin().replace(/\/+$/, '') ?? ''
  }

  /**
   * Absolute JSON-RPC endpoint shown to peers and in the panel.
   * @returns the endpoint URL, or the path alone when no origin is available.
   */
  rpcUrl(): string {
    const origin = this.origin()
    return origin.length === 0 ? this.config.server.rpcPath : joinUrl(origin, this.config.server.rpcPath)
  }

  /**
   * Build the current Agent Card.
   * @returns a detached card document.
   * @throws when no public URL or bound origin exists.
   */
  card(): AgentCardDocument {
    return buildAgentCard(this.config, this.origin())
  }

  /**
   * Whether the inbound endpoint can admit a bearer request right now.
   * @returns true in `none` mode, or when a token resolves.
   */
  async tokenConfigured(): Promise<boolean> {
    if (this.config.server.auth.mode === 'none') return true
    return (await resolveInboundToken(this.ctx, this.config)) !== undefined
  }

  /** Record one warning the first time an unauthenticated deployment is observed. */
  noteMissingToken(): void {
    if (this.warnedMissingToken) return
    this.warnedMissingToken = true
    this.ctx.logger.warn(
      'dsh-a2a: inbound bearer mode has no token; set one in Settings → A2A network or DSH_A2A_TOKEN. '
      + 'The Agent Card stays public and RPC requests are refused.',
    )
  }

  /**
   * Public liveness document. It intentionally omits token state so an
   * unauthenticated caller cannot probe the deployment's authentication.
   * @returns stable health fields.
   */
  health(): A2AHealth {
    return {
      ok: true,
      plugin: PLUGIN_NAME,
      version: this.config.server.version,
      protocolVersion: A2A_PROTOCOL_VERSION,
      serverEnabled: this.config.server.enabled,
      authMode: this.config.server.auth.mode,
      streaming: true,
      startedAt: this.startedAt,
    }
  }

  /**
   * Complete admin snapshot for the settings panel.
   * @returns server, client, task, and log facts.
   */
  /**
   * Accept or continue one task.
   *
   * @param input - normalized send input.
   * @returns the settled or current task.
   */
  async send(input: SendTaskInput, peer?: string): Promise<Task> {
    return this.ensureTasks().send(input, peer)
  }

  /**
   * Read one task.
   *
   * @param id - task id.
   * @param historyLength - maximum history entries.
   * @returns the wire task.
   */
  get(id: string, historyLength?: number): Task {
    return this.ensureTasks().get(id, historyLength)
  }

  /**
   * Cancel one task.
   *
   * @param id - task id.
   * @returns the canceled task.
   */
  cancel(id: string): Task {
    return this.ensureTasks().cancel(id)
  }

  /**
   * Subscribe to one task's events.
   *
   * @param id - task id.
   * @param callback - event sink.
   * @param replay - whether to emit the current status and artifact first.
   * @returns the disposer.
   */
  subscribe(id: string, callback: (event: TaskEvent) => void, replay: boolean): () => void {
    return this.ensureTasks().subscribe(id, callback, replay)
  }

  /**
   * Start one streaming send and attach an SSE writer.
   *
   * @param input - normalized send input.
   * @param id - JSON-RPC id echoed in every frame.
   * @param req - incoming request.
   * @param res - response owning the stream.
   */
  async streamSend(input: SendTaskInput, id: JsonRpcId, req: IncomingMessage, res: ServerResponse, peer?: string): Promise<void> {
    const manager = this.ensureTasks()
    const task = await manager.send({ ...input, blocking: false }, peer)
    const writer = openSse(req, res, id)
    const unsubscribe = manager.subscribe(task.id, event => { writer.send(event) }, true)
    if (writer.closed) unsubscribe()
    else writer.onClose(unsubscribe)
  }

  /**
   * Re-open one task's event stream.
   *
   * @param taskId - task id.
   * @param id - JSON-RPC id echoed in every frame.
   * @param req - incoming request.
   * @param res - response owning the stream.
   */
  streamResubscribe(taskId: string, id: JsonRpcId, req: IncomingMessage, res: ServerResponse): void {
    const manager = this.ensureTasks()
    const task = manager.get(taskId)
    const writer = openSse(req, res, id)
    const unsubscribe = manager.subscribe(task.id, event => { writer.send(event) }, true)
    if (writer.closed) unsubscribe()
    else writer.onClose(unsubscribe)
  }

  /**
   * Release task and agent resources.
   *
   * @returns fulfillment after every owned agent settles.
   */
  async dispose(): Promise<void> {
    this.registrar?.dispose()
    this.registrar = undefined
    this.registry = undefined
    this.outboundStarted = false
    await this.taskManager?.dispose()
    this.taskManager = undefined
  }

  /** Lazily construct the task manager and its agent adapter. */
  private ensureTasks(): TaskManager {
    if (this.taskManager !== undefined) return this.taskManager
    const executor = new AgentExecutor(this.ctx, this.config)
    const manager = new TaskManager(this.config, executor, (record, state) => {
      this.logs.record({
        direction: 'inbound',
        level: state === 'failed' ? 'warn' : 'info',
        taskId: record.id,
        contextId: record.contextId,
        state,
        ...record.peer === undefined ? {} : { peer: record.peer },
        message: state === 'failed' && record.error !== undefined ? `Task failed: ${record.error}` : `Task ${state}`,
      })
    })
    executor.bindSink(manager)
    this.taskManager = manager
    return manager
  }

  /** Discover enabled nodes and register their skills as tools. */
  async startOutbound(): Promise<void> {
    if (!this.config.client.enabled || this.outboundStarted) return
    this.outboundStarted = true
    const { registry, registrar } = this.ensureOutbound()
    this.logs.record({ direction: 'system', level: 'info', message: 'Discovering configured A2A nodes' })
    if (this.config.client.discoverOnStart) await registry.discoverAll()
    await registrar.sync()
    const discovered = registry.list().filter(node => node.card !== undefined).length
    this.logs.record({
      direction: 'system',
      level: 'info',
      message: `Outbound A2A ready: ${String(discovered)}/${String(this.config.client.nodes.length)} node(s) discovered`,
    })
  }

  /**
   * Refresh one node's card and reconcile tools.
   *
   * @param id - node id.
   * @returns the updated runtime.
   */
  async refreshNode(id: string): Promise<NodeRuntime> {
    const { registry, registrar } = this.ensureOutbound()
    const runtime = await registry.discover(id)
    await registrar.sync()
    return runtime
  }

  /**
   * Add or replace one node and optionally store its token.
   *
   * @param input - node fields.
   * @param token - bearer token to store; empty removes the record.
   */
  async upsertNode(input: NodeConfig, token?: string): Promise<void> {
    const nodes = [...this.config.client.nodes]
    const index = nodes.findIndex(node => node.id === input.id)
    if (index === -1) nodes.push(input)
    else nodes[index] = input
    const next = resolveConfig({ ...this.config, client: { ...this.config.client, nodes } })
    const saved = next.client.nodes.find(node => node.id === input.id)
    if (saved === undefined) throw new Error('The node could not be normalized')
    // Store the token before the configuration write: a config edit restarts
    // the plugin, and the credential must already be readable afterwards.
    if (token !== undefined) await this.writeToken(`${NODE_CREDENTIAL_PREFIX}${saved.id}`, token)
    await this.saveNodes(next.client.nodes)
  }

  /**
   * Remove one node and its credential record.
   *
   * @param id - node id.
   */
  async removeNode(id: string): Promise<void> {
    const nodes = this.config.client.nodes.filter(node => node.id !== id)
    if (nodes.length === this.config.client.nodes.length) throw new Error(`Unknown A2A node: ${id}`)
    const next = resolveConfig({ ...this.config, client: { ...this.config.client, nodes } })
    await this.saveNodes(next.client.nodes)
    await this.requireCredentials().deleteRecord?.(`${NODE_CREDENTIAL_PREFIX}${id}`)
  }

  /**
   * Store the inbound bearer token.
   *
   * @param token - token value; empty removes the record.
   */
  async setInboundToken(token: string): Promise<void> {
    await this.writeToken(INBOUND_CREDENTIAL_KEY, token)
  }

  /**
   * Store one inbound peer's bearer token.
   *
   * @param id - configured peer id.
   * @param token - token value; empty removes the record.
   */
  async setPeerToken(id: string, token: string): Promise<void> {
    if (!this.config.server.auth.peers.some(peer => peer.id === id)) throw new Error(`Unknown A2A peer: ${id}`)
    await this.writeToken(`${PEER_CREDENTIAL_PREFIX}${id}`, token)
  }

  /**
   * Store one node's bearer token.
   *
   * @param id - node id.
   * @param token - token value; empty removes the record.
   */
  async setNodeToken(id: string, token: string): Promise<void> {
    if (!this.config.client.nodes.some(node => node.id === id)) throw new Error(`Unknown A2A node: ${id}`)
    await this.writeToken(`${NODE_CREDENTIAL_PREFIX}${id}`, token)
  }

  /** Persist the complete node list through the config editor. */
  private async saveNodes(nodes: NodeConfig[]): Promise<void> {
    const editor = this.ctx.get('configEditor') as ConfigEditorService | undefined
    if (editor === undefined) {
      throw new Error('A2A node changes cannot be saved because the config editor is unavailable in this profile')
    }
    const entry = (this.ctx.fiber as typeof this.ctx.fiber & { entry?: unknown }).entry
    if (entry === undefined) throw new Error('A2A node changes cannot be saved outside a configuration row')
    await editor.edit(entry, current => ({
      ...current,
      client: { ...current.client, nodes },
    }))
  }

  /** Write or delete one credential record. */
  private async writeToken(key: string, token: string): Promise<void> {
    const credentials = this.requireCredentials()
    if (token.trim().length === 0) {
      await credentials.deleteRecord?.(key)
      return
    }
    if (credentials.modifyRecord === undefined) throw new Error('The credential store cannot write records')
    await credentials.modifyRecord(key, () => ({ kind: 'api-key', key: token.trim() }))
  }

  /** Require the credential service with a clear failure. */
  private requireCredentials(): CredentialsService {
    const credentials = this.ctx.get('credentials') as CredentialsService | undefined
    if (credentials === undefined) throw new Error('The DSH credentials service is unavailable')
    return credentials
  }

  /** Lazily construct the outbound registry, client, and tool registrar. */
  private ensureOutbound(): { registry: NodeRegistry; registrar: ToolRegistrar } {
    if (this.registry !== undefined && this.registrar !== undefined) {
      return { registry: this.registry, registrar: this.registrar }
    }
    const registry = new NodeRegistry(this.config, this.logs)
    const client = new A2AClient(this.ctx, this.config, this.logs)
    const registrar = new ToolRegistrar(this.ctx, this.config, registry, client, this.logs)
    this.registry = registry
    this.registrar = registrar
    return { registry, registrar }
  }

  async adminState(): Promise<A2AAdminState> {
    const enabledNodes = this.config.client.nodes.filter(node => node.enabled)
    const nodes: NodeRuntime[] = this.registry?.list() ?? this.config.client.nodes.map(node => ({
      id: node.id,
      name: node.name,
      url: node.url,
      enabled: node.enabled,
      autoDiscover: node.autoDiscover,
      authMode: node.auth.mode,
      tokenEnv: node.auth.tokenEnv,
      skills: 0,
      tools: [],
    }))
    return {
      plugin: {
        name: PLUGIN_NAME,
        version: this.config.server.version,
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
      server: {
        enabled: this.config.server.enabled,
        origin: this.origin(),
        rpcPath: this.config.server.rpcPath,
        rpcUrl: this.rpcUrl(),
        agentCardPath: this.config.server.agentCardPath,
        agentCardAliases: [...this.config.server.agentCardAliases],
        authMode: this.config.server.auth.mode,
        tokenConfigured: await this.tokenConfigured(),
        peers: await Promise.all(this.config.server.auth.peers.map(async peer => ({
          id: peer.id,
          tokenConfigured: (await resolvePeerToken(this.ctx, this.config, peer)) !== undefined,
        }))),
        streaming: true,
        pushNotifications: false,
        startedAt: this.startedAt,
      },
      client: {
        enabled: this.config.client.enabled,
        toolPrefix: this.config.client.toolPrefix,
        discoverOnStart: this.config.client.discoverOnStart,
        allowPrivateHosts: this.config.client.allowPrivateHosts,
        nodeCount: this.config.client.nodes.length,
        enabledNodeCount: enabledNodes.length,
        discoveredNodes: nodes.filter(node => node.card !== undefined).length,
        registeredTools: nodes.reduce((total, node) => total + node.tools.length, 0),
        nodes,
      },
      tasks: this.taskManager?.stats() ?? { active: 0, total: 0, byState: {} },
      logs: { capacity: this.config.logs.capacity, retained: this.logs.size(), recent: this.logs.recent(50) },
    }
  }
}

/**
 * Create the plugin's capability value.
 *
 * @param ctx - owning plugin context.
 * @param config - resolved configuration.
 * @returns the service instance to publish with `ctx.provide('a2a', …)`.
 */
export function createA2AService(ctx: Context, config: Config): A2AService {
  return new A2AService(ctx, config)
}
