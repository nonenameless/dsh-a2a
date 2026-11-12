import { describe, expect, it } from 'vitest'
import { INBOUND_CREDENTIAL_KEY, NODE_CREDENTIAL_PREFIX } from '../../src/shared/constants.ts'
import { Config, resolveConfig } from '../../src/host/config.ts'

/** DSH accepts a credential key as exactly `<scope>/<id>`; each segment is `[a-z][a-z0-9-]*`. */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/** Whether a value is a credential key the DSH credentials loader admits. */
function isValidCredentialKey(value: string): boolean {
  const segments = value.split('/')
  return segments.length === 2 && segments.every(segment => KEY_SEGMENT.test(segment))
}

describe('credential addresses', () => {
  it('keeps the inbound token key a valid two-segment key', () => {
    expect(isValidCredentialKey(INBOUND_CREDENTIAL_KEY)).toBe(true)
  })

  it('builds a valid node token key for every accepted node id', () => {
    const config = resolveConfig(Config({
      client: {
        nodes: [
          { id: 'openclaw', name: 'OpenClaw', url: 'http://127.0.0.1:18789' },
          { id: 'peer-2', name: 'Peer', url: 'https://agent.example.com' },
        ],
      },
    }))
    for (const node of config.client.nodes) {
      const key = `${NODE_CREDENTIAL_PREFIX}${node.id}`
      expect(isValidCredentialKey(key), key).toBe(true)
    }
  })

  it('rejects node ids that cannot be a credential id segment', () => {
    expect(() => resolveConfig(Config({
      client: { nodes: [{ id: 'my_peer', name: 'Peer', url: 'https://agent.example.com' }] },
    }))).toThrow(/client\.nodes\[0\]\.id/)
  })
})
