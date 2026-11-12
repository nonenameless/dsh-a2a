/**
 * Remote node runtime state: configured nodes plus their last discovered card.
 *
 * Configuration remains the source of truth for which nodes exist; this
 * registry only caches discovery results and the tools derived from them.
 *
 * @module @local/dsh-a2a/outbound/node-registry
 */

import type { Config, NodeConfig } from '../config.ts'
import type { LogBus } from '../admin/log-bus.ts'
import { fetchAgentCard, type AgentCardDocument } from './agent-card.ts'
import { messageOf } from '../../shared/errors.ts'
import { DISCOVERY_TIMEOUT_MS } from '../../shared/constants.ts'

/** One node's live state. */
export interface NodeRuntime {
  id: string
  name: string
  url: string
  enabled: boolean
  autoDiscover: boolean
  authMode: 'none' | 'bearer'
  tokenEnv: string
  card?: AgentCardDocument | undefined
  error?: string | undefined
  checkedAt?: string | undefined
  /** Number of skills advertised by the last successful discovery. */
  skills: number
  /** Tool names currently registered from this node. */
  tools: string[]
}

/** Discovery and cache owner. */
export class NodeRegistry {
  private readonly nodes = new Map<string, NodeRuntime>()

  /**
   * @param config - resolved plugin configuration.
   * @param logs - panel activity bus.
   */
  constructor(
    private readonly config: Config,
    private readonly logs: LogBus,
  ) {
    for (const node of config.client.nodes) {
      this.nodes.set(node.id, {
        id: node.id,
        name: node.name,
        url: node.url,
        enabled: node.enabled,
        autoDiscover: node.autoDiscover,
        authMode: node.auth.mode,
        tokenEnv: node.auth.tokenEnv,
        skills: 0,
        tools: [],
      })
    }
  }

  /**
   * List configured nodes and their last known state.
   *
   * @returns a detached array in configuration order.
   */
  list(): NodeRuntime[] {
    return this.config.client.nodes.flatMap(node => {
      const runtime = this.nodes.get(node.id)
      return runtime === undefined ? [] : [runtime]
    })
  }

  /**
   * Read one runtime.
   *
   * @param id - node id.
   * @returns the runtime, or undefined when unconfigured.
   */
  get(id: string): NodeRuntime | undefined {
    return this.nodes.get(id)
  }

  /**
   * Discover one node, updating its cache and error state.
   *
   * @param id - node id.
   * @returns the updated runtime.
   * @throws when the node is unknown or discovery fails.
   */
  async discover(id: string): Promise<NodeRuntime> {
    const runtime = this.nodes.get(id)
    const node = this.nodeConfig(id)
    if (runtime === undefined || node === undefined) throw new Error(`Unknown A2A node: ${id}`)

    try {
      const card = await fetchAgentCard(node.url, {
        timeoutMs: Math.min(this.config.client.requestTimeoutMs, DISCOVERY_TIMEOUT_MS),
        allowPrivateHosts: this.config.client.allowPrivateHosts,
      })
      runtime.card = card
      runtime.error = undefined
      runtime.checkedAt = new Date().toISOString()
      runtime.skills = card.skills.length
      this.logs.record({
        direction: 'outbound',
        level: 'info',
        peer: node.name,
        message: `Discovered ${String(card.skills.length)} skill(s) from ${node.url}`,
      })
      return runtime
    } catch (error: unknown) {
      runtime.error = messageOf(error)
      runtime.checkedAt = new Date().toISOString()
      this.logs.record({
        direction: 'outbound',
        level: 'warn',
        peer: node.name,
        message: `Discovery failed: ${runtime.error}`,
      })
      throw error
    }
  }

  /**
   * Discover every enabled node that opts into auto-discovery.
   *
   * @returns settled runtimes; failures are recorded on each runtime.
   */
  async discoverAll(): Promise<NodeRuntime[]> {
    const targets = this.config.client.nodes.filter(node => node.enabled && node.autoDiscover)
    await Promise.all(targets.map(async node => {
      await this.discover(node.id).catch(() => undefined)
    }))
    return this.list()
  }

  /**
   * Replace one node's registered tool names.
   *
   * @param id - node id.
   * @param tools - current tool names.
   */
  setTools(id: string, tools: string[]): void {
    const runtime = this.nodes.get(id)
    if (runtime !== undefined) runtime.tools = [...tools]
  }

  /** Read the configuration entry for one node. */
  private nodeConfig(id: string): NodeConfig | undefined {
    return this.config.client.nodes.find(node => node.id === id)
  }
}
