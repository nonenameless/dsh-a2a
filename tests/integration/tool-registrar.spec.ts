import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { LogBus } from '../../src/host/admin/log-bus.ts'
import { ToolRegistrar } from '../../src/host/outbound/tool-registrar.ts'
import type { NodeRuntime } from '../../src/host/outbound/node-registry.ts'
import type { AgentCard } from '../../src/shared/protocol.ts'

const config = resolveConfig(Config({
  client: {
    toolPrefix: 'a2a',
    nodes: [{
      id: 'peer',
      name: 'Peer',
      url: 'http://127.0.0.1:9999',
      enabled: true,
      autoDiscover: true,
      auth: { mode: 'none' },
    }],
  },
}))

/** Card with two skills. */
const card: AgentCard = {
  protocolVersion: '0.3.0',
  name: 'Peer',
  description: 'Mock peer',
  url: 'http://127.0.0.1:9999/a2a',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    { id: 'search', name: 'Search', description: 'Search the web', tags: ['search'] },
    { id: 'summarize', name: 'Summarize', description: 'Summarize text', tags: ['text'] },
  ],
}

describe('remote skill tool registrar', () => {
  it('registers one tool per skill and calls the remote client', async () => {
    const ctx = new Context()
    const registered = new Map<string, ToolDefinition>()
    ctx.provide('tools', {
      register(definition: ToolDefinition) {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    } as never)

    const runtime: NodeRuntime = {
      id: 'peer',
      name: 'Peer',
      url: config.client.nodes[0]!.url,
      enabled: true,
      autoDiscover: true,
      authMode: 'none',
      tokenEnv: 'DSH_A2A_TOKEN',
      card,
      skills: 2,
      tools: [],
    }
    const registry = {
      list: () => [runtime],
      setTools: (id: string, tools: string[]) => { if (id === 'peer') runtime.tools = tools },
    }
    const calls: Array<{ text: string; taskId?: string }> = []
    const client = {
      send: async (_node: unknown, _card: unknown, input: { text: string; taskId?: string }) => {
        calls.push(input)
        return { ok: true, state: 'completed', text: `echo:${input.text}` }
      },
    }
    const registrar = new ToolRegistrar(ctx, config, registry as never, client as never, new LogBus(20))
    await registrar.sync()

    expect([...registered.keys()].sort()).toEqual(['a2a__peer__search', 'a2a__peer__summarize'])
    expect(runtime.tools.sort()).toEqual(['a2a__peer__search', 'a2a__peer__summarize'])

    const tool = registered.get('a2a__peer__search')
    expect(tool).toBeDefined()
    const value = await tool!.execute(
      { input: 'find cats' },
      { signal: new AbortController().signal } as never,
    )
    expect(value).toMatchObject({ ok: true, text: 'echo:find cats' })
    expect(calls).toEqual([{ text: 'find cats' }])

    registrar.dispose()
    expect(registered.size).toBe(0)
  })

  it('removes tools when a node loses its card', async () => {
    const ctx = new Context()
    const registered = new Map<string, ToolDefinition>()
    ctx.provide('tools', {
      register(definition: ToolDefinition) {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    } as never)

    const runtime: NodeRuntime = {
      id: 'peer',
      name: 'Peer',
      url: config.client.nodes[0]!.url,
      enabled: true,
      autoDiscover: true,
      authMode: 'none',
      tokenEnv: 'DSH_A2A_TOKEN',
      card,
      skills: 2,
      tools: [],
    }
    const registry = {
      list: () => [runtime],
      setTools: () => {},
    }
    const client = { send: async () => ({ ok: true, state: 'completed', text: '' }) }
    const registrar = new ToolRegistrar(ctx, config, registry as never, client as never, new LogBus(20))
    await registrar.sync()
    expect(registered.size).toBe(2)

    runtime.card = undefined
    runtime.enabled = false
    await registrar.sync()
    expect(registered.size).toBe(0)
    registrar.dispose()
  })
})
