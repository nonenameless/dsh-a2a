import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as A2AConfig } from '../../src/host/config.ts'
import { A2AService } from '../../src/host/a2a-service.ts'

/** Build a service with fake config editor and credential store. */
function harness(peers: string[] = []) {
  const ctx = new Context()
  const config: A2AConfig = resolveConfig(Config(
    peers.length === 0
      ? {}
      : { server: { auth: { peers: peers.map(id => ({ id, tokenEnv: '' })) } } },
  ))
  Object.assign(ctx.fiber, { entry: { id: 'test-row' } })
  let saved: A2AConfig = config
  const records = new Map<string, { kind: string; key?: string }>()
  ctx.provide('configEditor', {
    edit: async (_entry: unknown, update: (current: A2AConfig) => A2AConfig) => {
      saved = update(config)
      return saved
    },
  } as never)
  ctx.provide('credentials', {
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, mutate: (current: unknown) => unknown) => {
      records.set(key, mutate(records.get(key)) as { kind: string; key?: string })
    },
    deleteRecord: async (key: string) => { records.delete(key) },
  } as never)
  return { ctx, config, service: new A2AService(ctx, config), records, get saved() { return saved } }
}

describe('per-peer tokens', () => {
  it('stores and clears one peer token under its own credential key', async () => {
    const h = harness(['openclaw'])
    await h.service.setPeerToken('openclaw', 'peer-secret')
    expect(h.records.get('dsh-a2a/peer-openclaw')).toEqual({ kind: 'api-key', key: 'peer-secret' })

    await h.service.setPeerToken('openclaw', '')
    expect(h.records.has('dsh-a2a/peer-openclaw')).toBe(false)
  })

  it('refuses an unconfigured peer', async () => {
    const h = harness(['openclaw'])
    await expect(h.service.setPeerToken('nobody', 'x')).rejects.toThrow(/Unknown A2A peer/)
  })
})

describe('admin node persistence', () => {
  it('writes the token before saving a normalized node list', async () => {
    const h = harness()
    await h.service.upsertNode({
      id: 'peer',
      name: 'Peer',
      url: 'https://peer.example.com',
      enabled: true,
      autoDiscover: true,
      auth: { mode: 'bearer', tokenEnv: 'PEER_TOKEN' },
    }, 'secret-token')

    // The record key is `<scope>/<id>`: a second slash would make the
    // credentials loader reject the document at the next boot.
    expect(h.records.get('dsh-a2a/node-peer')).toEqual({ kind: 'api-key', key: 'secret-token' })
    expect(h.saved.client.nodes).toEqual([{
      id: 'peer',
      name: 'Peer',
      url: 'https://peer.example.com',
      enabled: true,
      autoDiscover: true,
      auth: { mode: 'bearer', tokenEnv: 'PEER_TOKEN' },
    }])
  })

  it('stores and clears the inbound token', async () => {
    const h = harness()
    await h.service.setInboundToken('inbound-secret')
    expect(h.records.get('dsh-a2a/inbound')).toEqual({ kind: 'api-key', key: 'inbound-secret' })
    await h.service.setInboundToken('')
    expect(h.records.has('dsh-a2a/inbound')).toBe(false)
  })

  it('rejects an invalid node through the normal config validation', async () => {
    const h = harness()
    await expect(h.service.upsertNode({
      id: 'Bad ID',
      name: 'Peer',
      url: 'not-a-url',
      enabled: true,
      autoDiscover: true,
      auth: { mode: 'bearer', tokenEnv: 'PEER_TOKEN' },
    })).rejects.toThrow(/client\.nodes\[0\]/)
  })
})
