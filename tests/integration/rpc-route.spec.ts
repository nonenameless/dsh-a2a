import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { createA2AService } from '../../src/host/a2a-service.ts'
import { createRpcHandler } from '../../src/host/http/routes.ts'
import { A2A_ERROR } from '../../src/shared/protocol.ts'

/** Real Cordis context with no optional services; route registration is not exercised here. */
const context = new Context()

const config = resolveConfig(Config({}))
const service = createA2AService(context, config)
const handler = createRpcHandler(
  context,
  config,
  service,
  new Set(['https://allowed.example']),
)

let server: Server
let origin: string

beforeAll(async () => {
  vi.stubEnv('DSH_A2A_TOKEN', 'test-token')
  server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

/** Send one raw RPC request. */
async function request(
  body: string,
  headers: Record<string, string> = { authorization: 'Bearer test-token', 'content-type': 'application/json' },
): Promise<{ status: number; headers: Headers; json: any }> {
  const response = await fetch(`${origin}/a2a`, { method: 'POST', headers, body })
  const json: any = response.status === 204 ? undefined : await response.json().catch(() => undefined)
  return { status: response.status, headers: response.headers, json }
}

describe('RPC route', () => {
  it('admits a valid bearer request and answers method-not-found', async () => {
    const result = await request(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'unknown/method' }))
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ id: '1', error: { code: A2A_ERROR.methodNotFound } })
  })

  it('accepts a valid send envelope and reports an execution failure as a task', async () => {
    const result = await request(JSON.stringify({
      jsonrpc: '2.0',
      id: '2',
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: 'm-1',
          role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      },
    }))
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({
      id: '2',
      result: { kind: 'task', status: { state: 'failed' } },
    })
  })

  it('streams task events over SSE', async () => {
    const response = await fetch(`${origin}/a2a`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'stream-1',
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'm-stream',
            role: 'user',
            parts: [{ kind: 'text', text: 'stream' }],
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const frames = await response.text()
    expect(frames).toContain('"kind":"status-update"')
    expect(frames).toContain('"state":"failed"')
  })

  it('refuses a missing token with a challenge', async () => {
    const result = await request('{}', { 'content-type': 'application/json' })
    expect(result.status).toBe(401)
    expect(result.headers.get('www-authenticate')).toContain('Bearer')
    expect(result.json).toMatchObject({ error: { code: A2A_ERROR.invalidRequest } })
  })

  it('refuses a wrong token', async () => {
    const result = await request('{}', { authorization: 'Bearer wrong', 'content-type': 'application/json' })
    expect(result.status).toBe(401)
  })

  it('refuses a non-JSON content type', async () => {
    const result = await request('{}', { authorization: 'Bearer test-token', 'content-type': 'text/plain' })
    expect(result.status).toBe(415)
    expect(result.json).toMatchObject({ error: { code: A2A_ERROR.contentTypeNotSupported } })
  })

  it('reports a JSON parse error', async () => {
    const result = await request('{not json')
    expect(result.status).toBe(400)
    expect(result.json).toMatchObject({ error: { code: A2A_ERROR.parseError } })
  })

  it('rejects a batch envelope with 400', async () => {
    const result = await request(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tasks/get' }]))
    expect(result.status).toBe(400)
    expect(result.json).toMatchObject({ error: { code: A2A_ERROR.invalidRequest } })
  })

  it('rejects non-POST methods with Allow', async () => {
    const response = await fetch(`${origin}/a2a`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('answers an allowed preflight', async () => {
    const response = await fetch(`${origin}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'https://allowed.example' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('refuses a disallowed preflight origin', async () => {
    const response = await fetch(`${origin}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    expect(response.status).toBe(403)
  })

  it('enforces the body cap', async () => {
    const smallConfig = resolveConfig(Config({ server: { maxBodyBytes: 32 } }))
    const smallService = createA2AService(context, smallConfig)
    const smallHandler = createRpcHandler(context, smallConfig, smallService, new Set())
    const smallServer = createServer((req, res) => { void smallHandler(req, res) })
    await new Promise<void>((resolve) => { smallServer.listen(0, '127.0.0.1', resolve) })
    try {
      const address = smallServer.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/a2a`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'padding-padding' } }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ error: { code: A2A_ERROR.invalidRequest } })
    } finally {
      smallServer.closeAllConnections()
      await new Promise<void>((resolve) => { smallServer.close(() => { resolve() }) })
    }
  })

  it('returns 503 when no token is configured', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', '')
    const result = await request('{}', { authorization: 'Bearer anything', 'content-type': 'application/json' })
    expect(result.status).toBe(503)
    expect(JSON.stringify(result.json)).toContain('not configured')
    vi.stubEnv('DSH_A2A_TOKEN', 'test-token')
  })

  it('accepts the A2A 1.0 SendMessage shape with ROLE_USER and untyped parts', async () => {
    const result = await request(JSON.stringify({
      jsonrpc: '2.0',
      id: 'proto-1',
      method: 'SendMessage',
      params: {
        message: { messageId: 'm-proto', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
        configuration: { returnImmediately: true },
      },
    }))
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ id: 'proto-1', result: { kind: 'task' } })
    expect(typeof result.json.result.id).toBe('string')
  })

  it('serves the 1.0 GetTask name as an alias for tasks/get', async () => {
    const sent = await request(JSON.stringify({
      jsonrpc: '2.0',
      id: 'proto-send',
      method: 'SendMessage',
      params: {
        message: { messageId: 'm-proto-2', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
        configuration: { returnImmediately: true },
      },
    }))
    const taskId = sent.json.result.id as string
    const result = await request(JSON.stringify({
      jsonrpc: '2.0',
      id: 'proto-2',
      method: 'GetTask',
      params: { id: taskId },
    }))
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ id: 'proto-2', result: { id: taskId } })
  })
})
