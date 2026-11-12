import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../../src/host/config.ts'
import { buildAgentCard, parseAgentCard } from '../../src/host/outbound/agent-card.ts'

/** Build a resolved configuration from loader-shaped input. */
function config(input: Parameters<typeof Config>[0] = {}) {
  return resolveConfig(Config(input))
}

describe('local Agent Card', () => {
  it('advertises the RPC endpoint, protocol version, capabilities, and skills', () => {
    const card = buildAgentCard(config(), 'http://127.0.0.1:3080')
    expect(card.protocolVersion).toBe('0.3.0')
    expect(card.url).toBe('http://127.0.0.1:3080/a2a')
    expect(card.preferredTransport).toBe('JSONRPC')
    expect(card.capabilities.streaming).toBe(true)
    expect(card.capabilities.pushNotifications).toBe(false)
    expect(card.skills.map(skill => skill.id)).toEqual(['general'])
    expect(card.defaultInputModes).toContain('text/plain')
  })

  it('describes bearer authentication and the legacy authentication field', () => {
    const card = buildAgentCard(config(), 'http://127.0.0.1:3080')
    expect(card.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(card.security).toEqual([{ bearer: [] }])
    expect(card.authentication).toEqual({ schemes: ['Bearer'] })
  })

  it('omits security fields when authentication is disabled', () => {
    const card = buildAgentCard(config({ server: { auth: { mode: 'none' } } }), 'http://127.0.0.1:3080')
    expect(card.securitySchemes).toBeUndefined()
    expect(card.security).toBeUndefined()
    expect(card.authentication).toBeUndefined()
  })

  it('prefers the configured public URL over the bound origin', () => {
    const card = buildAgentCard(
      config({ server: { publicUrl: 'https://agents.example.com' } }),
      'http://127.0.0.1:3080',
    )
    expect(card.url).toBe('https://agents.example.com/a2a')
  })

  it('includes optional provider, icon, and documentation fields when configured', () => {
    const card = buildAgentCard(config({
      server: {
        providerOrganization: 'Example Org',
        providerUrl: 'https://example.com',
        iconUrl: 'https://example.com/icon.svg',
        documentationUrl: 'https://example.com/docs',
      },
    }), 'http://127.0.0.1:3080')
    expect(card.provider).toEqual({ organization: 'Example Org', url: 'https://example.com' })
    expect(card.iconUrl).toBe('https://example.com/icon.svg')
    expect(card.documentationUrl).toBe('https://example.com/docs')
  })

  it('fails when no origin is available', () => {
    expect(() => buildAgentCard(config(), '')).toThrow(/without a public URL/)
  })
})

describe('remote Agent Card parsing', () => {
  it('normalizes a valid card and resolves a relative endpoint', () => {
    const card = parseAgentCard({
      name: 'Peer',
      description: 'Remote',
      url: '/a2a',
      version: '2.1.0',
      protocolVersion: '0.3.0',
      capabilities: { streaming: true },
      skills: [{ id: 's1', name: 'Skill', description: 'Does things', tags: ['x'] }],
    }, 'https://peer.example.com')
    expect(card.url).toBe('https://peer.example.com/a2a')
    expect(card.protocolVersion).toBe('0.3.0')
    expect(card.capabilities.streaming).toBe(true)
    expect(card.skills[0]).toMatchObject({ id: 's1', tags: ['x'] })
  })

  it('rejects a card with no usable skills', () => {
    expect(() => parseAgentCard({
      name: 'Peer', description: 'Remote', url: 'https://peer.example.com/a2a', skills: [{ name: 'no id' }],
    }, 'https://peer.example.com')).toThrow(/no valid skills/)
  })

  it('rejects a private card endpoint when the policy forbids it', () => {
    expect(() => parseAgentCard({
      name: 'Peer',
      description: 'Remote',
      url: 'http://127.0.0.1:8080/a2a',
      skills: [{ id: 's1', name: 'Skill', tags: ['x'] }],
    }, 'https://peer.example.com', false)).toThrow(/Private and loopback/)
  })
})
