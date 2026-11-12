import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, resolveConfig } from '../../src/host/config.ts'
import type { A2AOwnerContext, CredentialRecordLike, CredentialsService } from '../../src/host/dsh.ts'
import {
  parseBearerToken,
  resolveInboundToken,
  timingSafeTokenEqual,
  verifyInboundBearer,
} from '../../src/host/http/auth.ts'

/** Build one resolved configuration. */
function config(input: Parameters<typeof Config>[0] = {}) {
  return resolveConfig(Config(input))
}

/** Build a context with an optional credential record. */
function context(record?: CredentialRecordLike, fail = false): A2AOwnerContext {
  const credentials: CredentialsService = {
    readRecord: async () => {
      if (fail) throw new Error('credential store unavailable')
      return record
    },
  }
  return {
    get(name) {
      return name === 'credentials' ? credentials : undefined
    },
    logger: { warn: () => {} },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('bearer parsing', () => {
  it('accepts a case-insensitive scheme and surrounding whitespace', () => {
    expect(parseBearerToken('  bEaReR   token-value  ')).toBe('token-value')
  })

  it('rejects malformed, empty, and comma-joined headers', () => {
    expect(parseBearerToken(undefined)).toBeUndefined()
    expect(parseBearerToken('')).toBeUndefined()
    expect(parseBearerToken('Bearer')).toBeUndefined()
    expect(parseBearerToken('Basic abc')).toBeUndefined()
    expect(parseBearerToken('Bearer a, Bearer b')).toBeUndefined()
    expect(parseBearerToken(`Bearer ${'x'.repeat(5000)}`)).toBeUndefined()
  })
})

describe('timing-safe comparison', () => {
  it('accepts equal tokens and rejects different ones', () => {
    expect(timingSafeTokenEqual('secret', 'secret')).toBe(true)
    expect(timingSafeTokenEqual('secret', 'secreu')).toBe(false)
    expect(timingSafeTokenEqual('', 'secret')).toBe(false)
  })
})

describe('inbound token resolution', () => {
  it('prefers a credential record over the environment', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'from-env')
    const token = await resolveInboundToken(context({ kind: 'api-key', key: 'from-store' }), config())
    expect(token).toBe('from-store')
  })

  it('falls back to the configured environment variable', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'from-env')
    const token = await resolveInboundToken(context(), config())
    expect(token).toBe('from-env')
  })

  it('ignores an empty environment value', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', '   ')
    const token = await resolveInboundToken(context(), config())
    expect(token).toBeUndefined()
  })

  it('ignores a record that is not an api-key', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'from-env')
    const token = await resolveInboundToken(context({ kind: 'grant', payload: {} }), config())
    expect(token).toBe('from-env')
  })

  it('falls back to the environment when the credential store fails', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'from-env')
    const token = await resolveInboundToken(context(undefined, true), config())
    expect(token).toBe('from-env')
  })
})

describe('inbound bearer decisions', () => {
  it('admits any request in none mode', async () => {
    expect(await verifyInboundBearer(context(), config({ server: { auth: { mode: 'none' } } }), undefined))
      .toEqual({ ok: true })
  })

  it('reports not-configured when no token exists', async () => {
    expect(await verifyInboundBearer(context(), config(), undefined))
      .toEqual({ ok: false, reason: 'not-configured' })
  })

  it('reports a missing header', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'secret')
    expect(await verifyInboundBearer(context(), config(), undefined))
      .toEqual({ ok: false, reason: 'missing' })
  })

  it('reports an invalid token', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'secret')
    expect(await verifyInboundBearer(context(), config(), 'Bearer wrong'))
      .toEqual({ ok: false, reason: 'invalid' })
  })

  it('admits the configured token', async () => {
    vi.stubEnv('DSH_A2A_TOKEN', 'secret')
    expect(await verifyInboundBearer(context(), config(), 'Bearer secret'))
      .toEqual({ ok: true })
  })
})

describe('per-peer inbound tokens', () => {
  /** Context without a credentials service, so peer tokenEnv values are used. */
  const envOnly: A2AOwnerContext = { get: () => undefined, logger: { warn: () => {} } }

  const peerConfig = config({
    server: { auth: { peers: [{ id: 'openclaw', tokenEnv: 'OPENCLAW_A2A_TOKEN' }] } },
  })

  it('admits a peer token and reports which peer it belongs to', async () => {
    vi.stubEnv('OPENCLAW_A2A_TOKEN', 'peer-secret')
    expect(await verifyInboundBearer(envOnly, peerConfig, 'Bearer peer-secret'))
      .toEqual({ ok: true, peer: 'openclaw' })
  })

  it('keeps the legacy token valid as an unnamed peer', async () => {
    vi.stubEnv('OPENCLAW_A2A_TOKEN', 'peer-secret')
    vi.stubEnv('DSH_A2A_TOKEN', 'legacy-secret')
    expect(await verifyInboundBearer(envOnly, peerConfig, 'Bearer legacy-secret'))
      .toEqual({ ok: true })
  })

  it('rejects a token that matches no configured peer', async () => {
    vi.stubEnv('OPENCLAW_A2A_TOKEN', 'peer-secret')
    expect(await verifyInboundBearer(envOnly, peerConfig, 'Bearer other'))
      .toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a peer id that is not a credential segment', () => {
    expect(() => config({ server: { auth: { peers: [{ id: 'bad_peer', tokenEnv: '' }] } } }))
      .toThrow(/server\.auth\.peers\[0\]\.id/)
  })
})
