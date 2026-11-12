import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { LogBus } from '../../src/host/admin/log-bus.ts'
import { A2AClient, isModernProtocol } from '../../src/host/outbound/rpc-client.ts'
import type { AgentCard, Task } from '../../src/shared/protocol.ts'

const config = resolveConfig(Config({
  client: {
    nodes: [{
      id: 'peer',
      name: 'Peer',
      url: 'http://127.0.0.1:1',
      enabled: true,
      autoDiscover: true,
      auth: { mode: 'bearer', tokenEnv: 'TEST_A2A_TOKEN' },
    }],
  },
}))

const node = config.client.nodes[0]!
const logs = new LogBus(20)
const client = new A2AClient(new Context(), config, logs)

let server: Server
let origin: string
let lastRequest: Record<string, any> = {}
let lastAuthorization: string | undefined
let reply: unknown = taskReply('completed', 'done')

/** Build one Task reply. */
function taskReply(state: string, text: string): Task {
  const task: Task = {
    kind: 'task',
    id: 'remote-task',
    contextId: 'remote-context',
    status: { state: state as Task['status']['state'] },
  }
  if (state === 'completed') {
    task.artifacts = [{ artifactId: 'a1', parts: [{ kind: 'text', text }] }]
  }
  if (state === 'input-required') {
    task.status.message = { kind: 'message', messageId: 'q', role: 'agent', parts: [{ kind: 'text', text }] }
  }
  return task
}

/** Card pointing at the local mock endpoint. */
function card(protocolVersion: string): AgentCard {
  return {
    protocolVersion,
    name: 'Peer',
    description: 'Mock peer',
    url: `${origin}/a2a`,
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }
}

beforeAll(async () => {
  vi.stubEnv('TEST_A2A_TOKEN', 'peer-token')
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
      lastRequest = body
      lastAuthorization = req.headers.authorization
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: reply }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

afterEach(() => {
  lastRequest = {}
  lastAuthorization = undefined
  reply = taskReply('completed', 'done')
})

describe('protocol selection', () => {
  it('selects 0.3 method names only for 0.3 and later', () => {
    expect(isModernProtocol('0.3.0')).toBe(true)
    expect(isModernProtocol('0.2.6')).toBe(false)
    expect(isModernProtocol('1.0.0')).toBe(true)
    expect(isModernProtocol(undefined)).toBe(false)
    expect(isModernProtocol('garbage')).toBe(false)
  })
})

describe('outbound A2A client', () => {
  it('uses message/send for a 0.3 peer and forwards the bearer token', async () => {
    const result = await client.send(node, card('0.3.0'), { text: 'hello' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'done' })
    expect(lastRequest.method).toBe('message/send')
    expect(lastRequest.params.message.parts).toEqual([{ kind: 'text', text: 'hello' }])
    expect(lastRequest.params.message.role).toBe('user')
    expect(lastAuthorization).toBe('Bearer peer-token')
  })

  it('uses tasks/send for a 0.2 peer', async () => {
    const result = await client.send(node, card('0.2.6'), { text: 'legacy' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'done' })
    expect(lastRequest.method).toBe('tasks/send')
    expect(lastRequest.params.message.parts).toEqual([{ kind: 'text', text: 'legacy' }])
    expect(typeof lastRequest.params.id).toBe('string')
  })

  it('projects input-required into a continuable tool result', async () => {
    reply = taskReply('input-required', 'Need approval')
    const result = await client.send(node, card('0.3.0'), { text: 'go' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'input-required', text: 'Need approval' })
    expect(result.taskId).toBe('remote-task')
  })

  it('surfaces a JSON-RPC error as a thrown failure', async () => {
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'remote rejected' } }))
    })
    await expect(client.send(node, card('0.3.0'), { text: 'bad' }, new AbortController().signal))
      .rejects.toThrow(/remote rejected/)
  })

  it('refuses an event-stream answer to a blocking send', async () => {
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A peer that keeps the stream open would otherwise never end the body.
      res.write('data: {"jsonrpc":"2.0"}\n\n')
    })
    await expect(client.send(node, card('0.3.0'), { text: 'stream' }, new AbortController().signal))
      .rejects.toThrow(/event stream/)
  })

  it('caps a response body that is larger than the accepted size', async () => {
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(Buffer.alloc(9 * 1024 * 1024, 0x78))
    })
    await expect(client.send(node, card('0.3.0'), { text: 'huge' }, new AbortController().signal))
      .rejects.toThrow(/exceeds 8388608 bytes/)
  })

  it('retries with the 1.0 SendMessage name when the peer reports method-not-found', async () => {
    server.removeAllListeners('request')
    const methods: string[] = []
    server.on('request', (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
        methods.push(body.method)
        res.writeHead(200, { 'content-type': 'application/json' })
        if (body.method === 'message/send') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }))
          return
        }
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            task: {
              id: 'proto-task',
              contextId: 'proto-context',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [{ artifactId: 'a1', parts: [{ text: 'proto-ok' }] }],
            },
          },
        }))
      })
    })
    const result = await client.send(node, card('1.0.0'), { text: 'hi' }, new AbortController().signal)
    expect(methods).toEqual(['message/send', 'SendMessage'])
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'proto-ok' })
  })

  it('projects an unwrapped 1.0 task reply such as Hermes sends', async () => {
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      // Exact shape observed from hermes-lingyu's A2A server: the task is the
      // result itself, the state is a proto enum, and parts carry mediaType.
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          id: 'task-hermes',
          contextId: 'ctx-hermes',
          status: {
            state: 'TASK_STATE_COMPLETED',
            timestamp: '2026-11-11T07:16:25.329Z',
            message: {
              role: 'ROLE_AGENT',
              parts: [{ text: 'hermes-ok', mediaType: 'text/plain' }],
              messageId: 'reply-hermes',
              contextId: 'ctx-hermes',
            },
          },
          artifacts: [{ artifactId: 'artifact-hermes', parts: [{ text: 'hermes-ok', mediaType: 'text/plain' }] }],
        },
      }))
    })
    const result = await client.send(node, card('1.0.0'), { text: 'hi' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, state: 'completed', text: 'hermes-ok', taskId: 'task-hermes', contextId: 'ctx-hermes' })
  })
})
