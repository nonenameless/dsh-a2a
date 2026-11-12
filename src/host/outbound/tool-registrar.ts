/**
 * Maps remote Agent Card skills onto DSH tools.
 *
 * One tool is registered per (node, skill). Registration is diffed against the
 * previous pass, so a refresh replaces only changed tools and a node that
 * disappears loses its tools. The model-facing schema stays small: a text
 * input plus optional continuation identities.
 *
 * @module @local/dsh-a2a/outbound/tool-registrar
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Config } from '../config.ts'
import type { ToolsService } from '../dsh.ts'
import type { LogBus } from '../admin/log-bus.ts'
import type { NodeRegistry, NodeRuntime } from './node-registry.ts'
import type { A2AClient, RemoteTaskResult } from './rpc-client.ts'
import { messageOf } from '../../shared/errors.ts'

/** One registered tool and its owner. */
interface Registration {
  name: string
  nodeId: string
  skillId: string
  card: import('./agent-card.ts').AgentCardDocument
  dispose: () => void
}

/** Output value produced by a remote-skill tool. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    state: { type: 'string' },
    taskId: { type: 'string' },
    contextId: { type: 'string' },
    text: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: false,
} as const

/** Dynamic tool registry for remote skills. */
export class ToolRegistrar {
  private registered = new Map<string, Registration>()
  private pending: Promise<void> = Promise.resolve()

  /**
   * @param ctx - plugin context.
   * @param config - resolved configuration.
   * @param registry - node cache.
   * @param client - outbound RPC client.
   * @param logs - activity bus.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly registry: NodeRegistry,
    private readonly client: A2AClient,
    private readonly logs: LogBus,
  ) {}

  /**
   * Reconcile registered tools with the current cards.
   *
   * @returns fulfillment after every registration attempt settles.
   */
  sync(): Promise<void> {
    const run = this.pending.then(async () => this.performSync())
    this.pending = run.catch(() => {})
    return run
  }

  /**
   * Release every tool owned by this registrar.
   */
  dispose(): void {
    for (const registration of this.registered.values()) registration.dispose()
    this.registered.clear()
  }

  /** Register missing tools, then release tools that no longer have a card. */
  private async performSync(): Promise<void> {
    const tools = this.ctx.get('tools') as ToolsService | undefined
    if (tools === undefined) {
      this.logs.record({ direction: 'system', level: 'warn', message: 'Tool registry is unavailable; remote skills were not mounted' })
      return
    }

    const desired = new Map<string, { runtime: NodeRuntime; skillId: string; name: string; card: NonNullable<NodeRuntime['card']> }>()
    const claimed = new Set([...this.registered.values()].map(entry => entry.name))
    for (const runtime of this.registry.list()) {
      if (!runtime.enabled || runtime.card === undefined) continue
      for (const skill of runtime.card.skills) {
        const key = `${runtime.id}/${skill.id}`
        const name = this.toolName(runtime, skill.id, claimed)
        claimed.add(name)
        desired.set(key, { runtime, skillId: skill.id, name, card: runtime.card })
      }
    }

    const next = new Map<string, Registration>()
    for (const [key, target] of desired) {
      const existing = this.registered.get(key)
      if (existing !== undefined && existing.card === target.card) {
        next.set(key, existing)
        continue
      }
      existing?.dispose()
      try {
        const tool = this.buildTool(target.runtime, target.skillId, target.name)
        const dispose = tools.register(tool)
        next.set(key, { name: target.name, nodeId: target.runtime.id, skillId: target.skillId, card: target.card, dispose })
        this.logs.record({
          direction: 'system',
          level: 'info',
          peer: target.runtime.name,
          message: `Registered tool ${target.name}`,
        })
      } catch (error: unknown) {
        this.logs.record({
          direction: 'system',
          level: 'warn',
          peer: target.runtime.name,
          message: `Could not register ${target.name}: ${messageOf(error)}`,
        })
      }
    }

    for (const [key, registration] of this.registered) {
      if (!next.has(key)) registration.dispose()
    }
    this.registered = next

    for (const runtime of this.registry.list()) {
      this.registry.setTools(
        runtime.id,
        [...next.values()].filter(entry => entry.nodeId === runtime.id).map(entry => entry.name),
      )
    }
  }

  /** Build one tool definition for a remote skill. */
  private buildTool(runtime: NodeRuntime, skillId: string, name: string): ToolDefinition {
    const node = this.config.client.nodes.find(candidate => candidate.id === runtime.id)
    const card = runtime.card
    const skill = card?.skills.find(candidate => candidate.id === skillId)
    if (node === undefined || card === undefined || skill === undefined) {
      throw new Error(`Remote skill ${skillId} is no longer available on ${runtime.id}`)
    }

    const client = this.client
    const examples = skill.examples === undefined || skill.examples.length === 0
      ? ''
      : `\nExamples: ${skill.examples.slice(0, 3).join(' | ')}`
    const description = [
      `Call the "${skill.name}" skill on remote A2A agent "${runtime.name}".`,
      skill.description,
      `Remote endpoint: ${card.url}.`,
      'Pass taskId to continue a task that returned state "input-required"; pass contextId to reuse a conversation.',
      examples,
    ].filter(part => part.length > 0).join('\n')

    return defineTool({
      name,
      description,
      parameters: {
        input: { type: 'string', description: 'Task text or question for the remote agent.', required: true },
        taskId: { type: 'string', description: 'Task id returned by a previous call, for an input-required continuation.' },
        contextId: { type: 'string', description: 'Conversation context id from a previous call.' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value): ContentBlock[] {
          const result = value as RemoteTaskResult
          const text = result.ok ? result.text : result.error ?? result.text
          return [{
            type: 'text',
            text: text.length > 0 ? text : `Remote task ${result.state}${result.taskId === undefined ? '' : ` (${result.taskId})`}`,
          }]
        },
      },
      timeoutMs: this.config.client.requestTimeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec): Promise<RemoteTaskResult> {
        return client.send(
          node,
          card,
          {
            text: args.input,
            ...args.taskId === undefined ? {} : { taskId: args.taskId },
            ...args.contextId === undefined ? {} : { contextId: args.contextId },
          },
          exec.signal,
        )
      },
    })
  }

  /** Build a collision-resistant, DSH-safe tool name. */
  private toolName(runtime: NodeRuntime, skillId: string, used: ReadonlySet<string>): string {
    const base = `${this.config.client.toolPrefix}__${slug(runtime.id)}__${slug(skillId)}`.slice(0, 64)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base.slice(0, 60)}_${String(suffix)}`
      suffix += 1
    }
    return candidate
  }
}

/** Sanitize one id segment for a tool name. */
function slug(value: string): string {
  const slugged = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  return slugged.length === 0 ? 'skill' : slugged
}
