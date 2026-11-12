import { describe, expect, it } from 'vitest'
import { CANONICAL_AGENT_CARD_PATH, DEFAULT_AGENT_CARD_PATH } from '../../src/shared/constants.ts'
import { Config, resolveConfig } from '../../src/host/config.ts'

/** Resolve a loader-shaped configuration input through schema and normalization. */
function resolved(input: Parameters<typeof Config>[0] = {}) {
  return resolveConfig(Config(input))
}

describe('plugin configuration', () => {
  it('fills every nested default', () => {
    const config = resolved()
    expect(config.server.enabled).toBe(true)
    expect(config.server.agentCardPath).toBe(DEFAULT_AGENT_CARD_PATH)
    expect(config.server.agentCardAliases).toEqual([CANONICAL_AGENT_CARD_PATH])
    expect(config.server.rpcPath).toBe('/a2a')
    expect(config.server.auth).toEqual({ mode: 'bearer', tokenEnv: 'DSH_A2A_TOKEN', peers: [] })
    expect(config.server.skills).toHaveLength(1)
    expect(config.server.skills[0]?.id).toBe('general')
    expect(config.client.toolPrefix).toBe('a2a')
    expect(config.logs.capacity).toBe(500)
  })

  it('keeps a partial server block while defaulting the rest', () => {
    const config = resolved({ server: { name: 'Remote helper', auth: { mode: 'none' } } })
    expect(config.server.name).toBe('Remote helper')
    expect(config.server.auth.mode).toBe('none')
    expect(config.server.auth.tokenEnv).toBe('DSH_A2A_TOKEN')
    expect(config.server.rpcPath).toBe('/a2a')
  })

  it('normalizes a public URL and deduplicates card aliases', () => {
    const config = resolved({
      server: {
        publicUrl: 'https://agents.example.com/',
        agentCardPath: '/card',
        agentCardAliases: ['/card', '/alias', '/alias/'],
      },
    })
    expect(config.server.publicUrl).toBe('https://agents.example.com')
    expect(config.server.agentCardAliases).toEqual(['/alias'])
  })

  it('normalizes CORS origins to bare origins', () => {
    const config = resolved({ server: { corsOrigins: ['https://a.example.com/', 'https://a.example.com'] } })
    expect(config.server.corsOrigins).toEqual(['https://a.example.com'])
  })

  it('rejects a relative or malformed path', () => {
    expect(() => resolveConfig(Config({ server: { rpcPath: 'a2a' } }))).toThrow(/must start with/)
    expect(() => resolveConfig(Config({ server: { rpcPath: '/a2a?x=1' } }))).toThrow(/must not contain/)
  })

  it('rejects a route collision with the card, health, or admin path', () => {
    expect(() => resolveConfig(Config({ server: { rpcPath: '/a2a/health' } })))
      .toThrow(/must not collide/)
    expect(() => resolveConfig(Config({ server: { agentCardAliases: ['/a2a/admin/state'] } })))
      .toThrow(/must not collide/)
  })

  it('rejects a duplicate skill id', () => {
    expect(() => resolved({
      server: {
        skills: [
          { id: 'one', name: 'One', description: '', tags: ['x'], examples: [] },
          { id: 'one', name: 'Two', description: '', tags: ['y'], examples: [] },
        ],
      },
    })).toThrow(/duplicates skill id/)
  })

  it('rejects an empty skill list', () => {
    expect(() => resolved({ server: { skills: [] } })).toThrow(/at least one skill/)
  })

  it('rejects tags that normalize to empty', () => {
    expect(() => resolved({
      server: { skills: [{ id: 'one', name: 'One', description: '', tags: ['  '], examples: [] }] },
    })).toThrow(/at least one tag/)
  })

  it('rejects a half-specified model route', () => {
    expect(() => resolved({ server: { model: { provider: 'deepseek' } } })).toThrow(/both provider and model/)
  })

  it('rejects duplicate node ids', () => {
    const node = { id: 'peer', name: 'Peer', url: 'https://peer.example.com', enabled: true, autoDiscover: true }
    expect(() => resolved({ client: { nodes: [node, { ...node, name: 'Peer 2' }] } })).toThrow(/duplicates node id/)
  })

  it('rejects an invalid tool prefix', () => {
    expect(() => resolved({ client: { toolPrefix: 'A2A!' } })).toThrow(/toolPrefix/)
  })

  it('rejects a credential-bearing node URL', () => {
    expect(() => resolved({
      client: { nodes: [{ id: 'peer', name: 'Peer', url: 'https://user:pass@peer.example.com' }] },
    })).toThrow(/must not embed credentials/)
  })
})
