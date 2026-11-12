import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { A2A_ERROR } from '../../src/shared/protocol.ts'
import { A2AProtocolError } from '../../src/shared/errors.ts'
import { createA2AService } from '../../src/host/a2a-service.ts'
import { Config, resolveConfig } from '../../src/host/config.ts'
import {
  dispatchJsonRpc,
  idOf,
  toErrorResponse,
  validateJsonRpcRequest,
  type RpcHandler,
  type RpcRuntime,
} from '../../src/host/http/jsonrpc.ts'

/** Configuration used by dispatcher tests. */
const config = resolveConfig(Config({}))

/** Real Cordis context without any optional service. */
const context = new Context()

/** Runtime with no installed method handlers. */
function runtime(methods: ReadonlyMap<string, RpcHandler> = new Map()): RpcRuntime {
  return {
    config,
    service: createA2AService(context, config),
    logger: { warn: () => {} },
    methods,
  }
}

describe('JSON-RPC envelope validation', () => {
  it('accepts a string id and object params', () => {
    expect(validateJsonRpcRequest({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: { message: {} },
    })).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: { message: {} },
    })
  })

  it('accepts a finite numeric id', () => {
    expect(validateJsonRpcRequest({ jsonrpc: '2.0', id: 7, method: 'tasks/get' }).id).toBe(7)
  })

  it('rejects a batch', () => {
    expect(() => validateJsonRpcRequest([])).toThrow(/Batch/)
  })

  it('rejects a null or missing id', () => {
    expect(() => validateJsonRpcRequest({ jsonrpc: '2.0', id: null, method: 'tasks/get' }))
      .toThrow(/id must not be null/)
    expect(() => validateJsonRpcRequest({ jsonrpc: '2.0', method: 'tasks/get' }))
      .toThrow(/id is required/)
  })

  it('rejects array params', () => {
    expect(() => validateJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: [] }))
      .toThrow(/params must be an object/)
  })

  it('rejects a non-object request', () => {
    expect(() => validateJsonRpcRequest('nope')).toThrow(/JSON object/)
  })
})

describe('JSON-RPC dispatch', () => {
  it('returns method-not-found for an unknown method', async () => {
    const response = await dispatchJsonRpc({ jsonrpc: '2.0', id: '1', method: 'unknown/method' }, runtime())
    expect(response).toMatchObject({ id: '1', error: { code: A2A_ERROR.methodNotFound } })
  })

  it('returns unsupported-operation for a known but unwired method', async () => {
    const response = await dispatchJsonRpc({ jsonrpc: '2.0', id: '1', method: 'message/send' }, runtime())
    expect(response).toMatchObject({ id: '1', error: { code: A2A_ERROR.unsupportedOperation } })
  })

  it('returns the handler result', async () => {
    const methods = new Map<string, RpcHandler>([
      ['message/send', async () => ({ ok: true })],
    ])
    const response = await dispatchJsonRpc(
      { jsonrpc: '2.0', id: '2', method: 'message/send', params: {} },
      runtime(methods),
    )
    expect(response).toEqual({ jsonrpc: '2.0', id: '2', result: { ok: true } })
  })

  it('projects a handler protocol fault', async () => {
    const methods = new Map<string, RpcHandler>([
      ['tasks/get', async () => { throw new A2AProtocolError(A2A_ERROR.taskNotFound, 'Task not found') }],
    ])
    const response = await dispatchJsonRpc(
      { jsonrpc: '2.0', id: '3', method: 'tasks/get', params: { id: 'missing' } },
      runtime(methods),
    )
    expect(response).toMatchObject({ id: '3', error: { code: A2A_ERROR.taskNotFound } })
  })

  it('maps an unexpected failure to an internal error without its message', async () => {
    const methods = new Map<string, RpcHandler>([
      ['tasks/get', async () => { throw new Error('database password is hunter2') }],
    ])
    const response = await dispatchJsonRpc(
      { jsonrpc: '2.0', id: '4', method: 'tasks/get', params: { id: 'x' } },
      runtime(methods),
    )
    expect(response).toMatchObject({ id: '4', error: { code: A2A_ERROR.internalError } })
    expect(JSON.stringify(response)).not.toContain('hunter2')
  })
})

describe('error helpers', () => {
  it('extracts a valid id and falls back to null', () => {
    expect(idOf({ id: 'a' })).toBe('a')
    expect(idOf({ id: 3 })).toBe(3)
    expect(idOf({ id: {} })).toBeNull()
    expect(idOf(null)).toBeNull()
  })

  it('does not leak an unexpected error message', () => {
    const response = toErrorResponse('5', new Error('secret detail'))
    expect(response).toMatchObject({ id: '5', error: { code: A2A_ERROR.internalError } })
    expect(JSON.stringify(response)).not.toContain('secret detail')
  })
})
