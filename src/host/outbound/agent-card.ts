/**
 * Local Agent Card construction.
 *
 * The card is public discovery metadata. It advertises the JSON-RPC endpoint,
 * capabilities, and skills, and describes the security scheme without ever
 * carrying a token. `agent.json` is this plugin's primary path; the 0.3
 * canonical alias is served by the route layer from the same document.
 *
 * @module @local/dsh-a2a/outbound/agent-card
 */

import { isRecord, A2A_PROTOCOL_VERSION, JSON_MEDIA_TYPE, TEXT_MEDIA_TYPE, type AgentCard, type AgentSkill, type SecurityScheme } from '../../shared/protocol.ts'
import type { Config } from '../config.ts'
import { readBoundedText } from '../http/body.ts'

/** Largest accepted Agent Card document. */
const MAX_CARD_BYTES = 1_048_576

/**
 * Agent Card plus the 0.2-era `authentication` field.
 *
 * A2A 0.2 readers look for `authentication.schemes`; 0.3 readers use
 * `securitySchemes` + `security`. Emitting both keeps one document discoverable
 * by deployed clients without a second card variant.
 */
export interface AgentCardDocument extends AgentCard {
  /** Legacy 0.2 authentication summary. */
  authentication?: { schemes: string[] }
}

/**
 * Join a base URL with one absolute path.
 *
 * @param base - origin or reverse-proxy prefix without a trailing slash.
 * @param path - absolute pathname beginning with `/`.
 * @returns the absolute endpoint URL.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * Build the local Agent Card.
 *
 * @param config - resolved plugin configuration.
 * @param origin - bound public origin used when `server.publicUrl` is empty.
 * @returns a detached card document.
 * @throws when neither a configured public URL nor a bound origin exists.
 */
export function buildAgentCard(config: Config, origin: string): AgentCardDocument {
  const base = config.server.publicUrl.length > 0 ? config.server.publicUrl : origin.replace(/\/+$/, '')
  if (base.length === 0) {
    throw new Error('dsh-a2a: cannot build the Agent Card without a public URL or a bound web server origin')
  }

  const skills: AgentSkill[] = config.server.skills.map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    ...skill.examples.length === 0 ? {} : { examples: [...skill.examples] },
  }))

  const bearer: SecurityScheme = {
    type: 'http',
    scheme: 'bearer',
    description: 'Send the configured token as `Authorization: Bearer <token>`.',
  }

  const card: AgentCardDocument = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: config.server.name,
    description: config.server.description,
    url: joinUrl(base, config.server.rpcPath),
    preferredTransport: 'JSONRPC',
    version: config.server.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: [TEXT_MEDIA_TYPE, JSON_MEDIA_TYPE],
    defaultOutputModes: [TEXT_MEDIA_TYPE, JSON_MEDIA_TYPE],
    skills,
    supportsAuthenticatedExtendedCard: false,
  }

  if (config.server.auth.mode === 'bearer') {
    card.securitySchemes = { bearer }
    card.security = [{ bearer: [] }]
    card.authentication = { schemes: ['Bearer'] }
  }
  if (config.server.providerOrganization.length > 0) {
    card.provider = {
      organization: config.server.providerOrganization,
      ...config.server.providerUrl.length === 0 ? {} : { url: config.server.providerUrl },
    }
  }
  if (config.server.iconUrl.length > 0) card.iconUrl = config.server.iconUrl
  if (config.server.documentationUrl.length > 0) card.documentationUrl = config.server.documentationUrl

  return card
}

/** Options controlling remote card discovery. */
export interface DiscoveryOptions {
  /** Per-request budget in milliseconds. */
  timeoutMs: number
  /** Whether loopback/private destinations are allowed. */
  allowPrivateHosts: boolean
  /** Caller cancellation. */
  signal?: AbortSignal
}

/** Paths probed in order: 0.3 canonical first, then the legacy path. */
const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'] as const

/**
 * Fetch and validate one remote Agent Card.
 *
 * @param baseUrl - node base URL without a trailing slash.
 * @param options - timeout, private-network policy, and cancellation.
 * @returns the normalized card.
 * @throws when neither path yields a valid card or the destination is refused.
 */
export async function fetchAgentCard(baseUrl: string, options: DiscoveryOptions): Promise<AgentCardDocument> {
  const base = baseUrl.replace(/\/+$/, '')
  assertAllowedUrl(base, options.allowPrivateHosts)
  let lastError: Error | undefined

  for (const path of CARD_PATHS) {
    const url = `${base}${path}`
    assertAllowedUrl(url, options.allowPrivateHosts)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('Agent Card discovery timed out')) }, options.timeoutMs)
    timer.unref?.()
    const onAbort = (): void => { controller.abort(options.signal?.reason) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Agent Card discovery refused a redirect: HTTP ${String(response.status)}`)
      }
      if (response.status === 404 || response.status === 405) {
        lastError = new Error(`Agent Card not found at ${url}`)
        continue
      }
      if (!response.ok) throw new Error(`Agent Card request failed: HTTP ${String(response.status)}`)
      const text = await readBoundedText(response, MAX_CARD_BYTES)
      return parseAgentCard(JSON.parse(text), base, options.allowPrivateHosts)
    } catch (error: unknown) {
      if (options.signal?.aborted === true) throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
  throw lastError ?? new Error('Agent Card discovery failed')
}

/**
 * Validate and normalize one remote Agent Card.
 *
 * @param value - parsed JSON value.
 * @param baseUrl - node base URL used to resolve a relative endpoint.
 * @returns a normalized card.
 * @throws when required fields are missing or unsafe.
 */
export function parseAgentCard(value: unknown, baseUrl: string, allowPrivateHosts = true): AgentCardDocument {
  if (!isRecord(value)) throw new Error('Agent Card must be a JSON object')
  if (typeof value.name !== 'string' || value.name.length === 0) throw new Error('Agent Card name is required')
  if (!Array.isArray(value.skills)) throw new Error('Agent Card skills must be an array')

  const interfaces = Array.isArray(value.supportedInterfaces)
    ? value.supportedInterfaces.flatMap(iface => {
      if (!isRecord(iface) || typeof iface.url !== 'string') return []
      return [{
        url: iface.url,
        ...typeof iface.transport === 'string' ? { transport: iface.transport } : {},
        ...typeof iface.protocolBinding === 'string' ? { protocolBinding: iface.protocolBinding } : {},
        ...typeof iface.protocolVersion === 'string' ? { protocolVersion: iface.protocolVersion } : {},
      }]
    })
    : []
  const jsonRpc = interfaces.find(iface => iface.protocolBinding === 'JSONRPC' || iface.transport === 'JSONRPC') ?? interfaces[0]
  const endpoint = typeof value.url === 'string' && value.url.length > 0
    ? new URL(value.url, baseUrl).toString()
    : jsonRpc === undefined
      ? baseUrl
      : new URL(jsonRpc.url, baseUrl).toString()
  assertAllowedUrl(endpoint, allowPrivateHosts)

  const skills: AgentSkill[] = value.skills.flatMap(skill => {
    if (!isRecord(skill) || typeof skill.id !== 'string' || typeof skill.name !== 'string') return []
    return [{
      id: skill.id,
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : '',
      tags: Array.isArray(skill.tags) ? skill.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      ...Array.isArray(skill.examples)
        ? { examples: skill.examples.filter((example): example is string => typeof example === 'string') }
        : {},
    }]
  })
  if (skills.length === 0) throw new Error('Agent Card advertises no valid skills')

  const capabilities = isRecord(value.capabilities) ? value.capabilities : {}
  const protocolVersion = typeof value.protocolVersion === 'string'
    ? value.protocolVersion
    : jsonRpc?.protocolVersion ?? '0.2.6'
  return {
    protocolVersion,
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
    url: endpoint,
    preferredTransport: typeof value.preferredTransport === 'string'
      ? value.preferredTransport
      : jsonRpc?.protocolBinding ?? jsonRpc?.transport ?? 'JSONRPC',
    ...interfaces.length === 0 ? {} : { supportedInterfaces: interfaces },
    version: typeof value.version === 'string' ? value.version : '0.0.0',
    capabilities: {
      streaming: capabilities.streaming === true,
      pushNotifications: capabilities.pushNotifications === true,
      stateTransitionHistory: capabilities.stateTransitionHistory === true,
    },
    defaultInputModes: Array.isArray(value.defaultInputModes)
      ? value.defaultInputModes.filter((mode): mode is string => typeof mode === 'string')
      : [TEXT_MEDIA_TYPE],
    defaultOutputModes: Array.isArray(value.defaultOutputModes)
      ? value.defaultOutputModes.filter((mode): mode is string => typeof mode === 'string')
      : [TEXT_MEDIA_TYPE, JSON_MEDIA_TYPE],
    skills,
    ...typeof value.iconUrl === 'string' ? { iconUrl: value.iconUrl } : {},
    ...typeof value.documentationUrl === 'string' ? { documentationUrl: value.documentationUrl } : {},
  }
}

/** Refuse credential-bearing, non-HTTP, and (by policy) private destinations. */
function assertAllowedUrl(value: string, allowPrivateHosts: boolean): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid remote URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Remote URL must use http or https')
  if (url.username.length > 0 || url.password.length > 0) throw new Error('Remote URL must not embed credentials')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new Error('Remote URL points at a metadata endpoint')
  }
  if (allowPrivateHosts) return
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error('Private and loopback destinations are disabled by client.allowPrivateHosts')
  }
}
