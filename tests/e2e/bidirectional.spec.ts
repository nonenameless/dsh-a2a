import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type NodeConfig } from '../../src/host/config.ts'
import { A2AService } from '../../src/host/a2a-service.ts'
import { A2AClient } from '../../src/host/outbound/rpc-client.ts'
import { LogBus } from '../../src/host/admin/log-bus.ts'
import { createRpcHandler } from '../../src/host/http/routes.ts'
import type { AgentCard } from '../../src/shared/protocol.ts'

const serverConfig = resolveConfig(Config({
  server: { auth: { mode: 'bearer', tokenEnv: 'E2E_TOKEN' }, timeoutMs: 5_000 },
}))

const node: NodeConfig = {
  id: 'loopback',
  name: 'Loopback',
  url: 'http://127.0.0.1:1',
  enabled: true,
  autoDiscover: true,
  auth: { mode: 'bearer', tokenEnv: 'E2E_TOKEN' },
}

const logs = new LogBus(50)
const ctx = new Context()
let server: Server
let origin: string
let createdSessionId = ''
let service: A2AService

/** Build a card for the loopback server. */
function card(protocolVersion: string): AgentCard {
  return {
    protocolVersion,
    name: 'Loopback',
    description: 'E2E peer',
    url: `${origin}/a2a`,
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }
}

beforeAll(async () => {
  vi.stubEnv('E2E_TOKEN', 'e2e-token')
  const agentCtx = new Context()
  const agent = {
    id: '',
    session: { id: '' },
    ctx: agentCtx,
    followup: () => {
      queueMicrotask(() => {
        ctx.emit('session/event', { id: createdSessionId } as never, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'pong' }] } },
        } as never)
        ctx.emit('session/event', { id: createdSessionId } as never, {
          type: 'turn/end',
          data: { reason: { kind: 'completed' } },
        } as never)
      })
    },
    cancel: () => {},
  }
  const agents = {
    get: () => undefined,
    create: async (options: { sessionId: string }) => {
      createdSessionId = options.sessionId
      agent.id = options.sessionId
      agent.session.id = options.sessionId
      return { agent, dispose: async () => {} }
    },
    resume: async () => ({ agent, dispose: async () => {} }),
  }
  ctx.provide('agents', agents as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'e2e', model: 'e2e-model' }),
  } as never)

  service = new A2AService(ctx, serverConfig)
  ctx.provide('a2a', service)
  const handler = createRpcHandler(ctx, serverConfig, service, new Set())
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await service.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

describe('bidirectional A2A over real HTTP', () => {
  it('round-trips a 0.3 message/send through the outbound client', async () => {
    const client = new A2AClient(ctx, serverConfig, logs)
    const result = await client.send(node, card('0.3.0'), { text: 'ping' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'pong' })
    expect(result.taskId).toBeTypeOf('string')
  })

  it('round-trips a 0.2 tasks/send through the outbound client', async () => {
    const client = new A2AClient(ctx, serverConfig, logs)
    const result = await client.send(node, card('0.2.6'), { text: 'legacy' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'pong' })
  })

  it('streams a message/stream request over SSE', async () => {
    const response = await fetch(`${origin}/a2a`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer e2e-token',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'e2e-stream',
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'e2e-message',
            role: 'user',
            parts: [{ kind: 'text', text: 'ping' }],
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    const frames = await response.text()
    expect(frames).toContain('"kind":"status-update"')
    expect(frames).toContain('"kind":"artifact-update"')
    expect(frames).toContain('pong')
  })
})
