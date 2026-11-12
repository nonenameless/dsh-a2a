/**
 * Plugin configuration schema, defaults, and load-time normalization.
 *
 * The Loader validates the row's `config` against `Config` before `apply`, so
 * by the time this module's `resolveConfig` runs every field exists. It still
 * normalizes and cross-checks deployment choices that schemastery cannot
 * express: path syntax, unique skill ids, mutually exclusive URL fields, and
 * duplicate node ids. Misconfiguration fails at activation, not on the first
 * request.
 *
 * @module @local/dsh-a2a/config
 */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  ADMIN_STATE_PATH,
  CANONICAL_AGENT_CARD_PATH,
  DEFAULT_AGENT_CARD_PATH,
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_LOG_CAPACITY,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_RPC_PATH,
  DEFAULT_SERVER_TIMEOUT_MS,
  DEFAULT_TOKEN_ENV,
  HEALTH_PATH,
} from '../shared/constants.ts'

/** Inbound authentication mode. */
export type AuthMode = 'none' | 'bearer'

/** One skill advertised in the Agent Card. */
export interface SkillConfig {
  /** Stable skill id, unique within the card. */
  id: string
  /** Human-readable skill name. */
  name: string
  /** What the skill does; model-facing when mapped to a remote tool. */
  description: string
  /** Search/classification tags. */
  tags: string[]
  /** Example prompts that exercise the skill. */
  examples: string[]
}

/** Model route used for inbound A2A tasks; empty fields defer to `agentDefaultModel`. */
export interface ModelConfig {
  provider: string
  model: string
  reasoningEffort: string
}

/** Bearer settings shared by the inbound server and one outbound node. */
export interface AuthConfig {
  /** `none` disables authentication; `bearer` requires a token. */
  mode: AuthMode
  /** Environment variable read when no credential record is stored. */
  tokenEnv: string
}

/** One inbound peer and where its bearer token is read from. */
export interface PeerAuthConfig {
  /** Peer id; also addresses its credential record `dsh-a2a/peer-<id>`. */
  id: string
  /** Environment variable read when no credential record is stored; empty disables the fallback. */
  tokenEnv: string
}

/** Inbound bearer authentication settings. */
export interface ServerAuthConfig extends AuthConfig {
  /**
   * Per-peer tokens. A request whose bearer matches one of these is admitted as
   * that peer; the legacy single token stays accepted as an unnamed peer.
   */
  peers: PeerAuthConfig[]
}

/** Inbound A2A server settings. */
export interface ServerConfig {
  /** Whether HTTP routes are registered. */
  enabled: boolean
  /** Externally reachable base URL; empty uses `ctx.webServer.getOrigin()`. */
  publicUrl: string
  /** Primary Agent Card path. */
  agentCardPath: string
  /** Additional Agent Card paths serving the same document. */
  agentCardAliases: string[]
  /** JSON-RPC endpoint path. */
  rpcPath: string
  /** Agent name in the card. */
  name: string
  /** Agent description in the card. */
  description: string
  /** Agent version in the card (not the protocol version). */
  version: string
  /** Inbound authentication. */
  auth: ServerAuthConfig
  /** Advertised skills. */
  skills: SkillConfig[]
  /** Model route for inbound tasks. */
  model: ModelConfig
  /** Working directory for inbound agents; empty uses the process working directory. */
  cwd: string
  /** End-to-end budget for one inbound task. */
  timeoutMs: number
  /** Request-body cap in bytes. */
  maxBodyBytes: number
  /** Browser origins allowed to call the RPC endpoint; empty allows same-origin only. */
  corsOrigins: string[]
  /** Optional provider organization for the card. */
  providerOrganization: string
  /** Optional provider URL for the card. */
  providerUrl: string
  /** Optional icon URL for the card. */
  iconUrl: string
  /** Optional documentation URL for the card. */
  documentationUrl: string
}

/** One remote A2A node. */
export interface NodeConfig {
  /** Stable local id; also addresses the node's credential record. */
  id: string
  /** Display name. */
  name: string
  /** Base URL of the remote agent, without the JSON-RPC path. */
  url: string
  /** Whether the node participates in discovery and tool registration. */
  enabled: boolean
  /** Whether to fetch the card and register its skills as tools. */
  autoDiscover: boolean
  /** Outbound bearer authentication. */
  auth: AuthConfig
}

/** Outbound A2A client settings. */
export interface ClientConfig {
  /** Whether outbound discovery and tool registration run. */
  enabled: boolean
  /** Prefix for generated tool names. */
  toolPrefix: string
  /** Whether to discover enabled nodes at activation. */
  discoverOnStart: boolean
  /** Whether private/loopback destinations are allowed. */
  allowPrivateHosts: boolean
  /** Per-request budget for outbound calls. */
  requestTimeoutMs: number
  /** Configured remote nodes. */
  nodes: NodeConfig[]
}

/** Panel log retention settings. */
export interface LogsConfig {
  /** Number of entries retained in the in-memory ring. */
  capacity: number
}

/** Resolved plugin configuration. */
export interface Config {
  server: ServerConfig
  client: ClientConfig
  logs: LogsConfig
}

/** Loader input: every object may be omitted and every field may be partial. */
export interface ConfigInput {
  server?: Partial<Omit<ServerConfig, 'auth' | 'model' | 'skills'>> & {
    auth?: Partial<ServerAuthConfig>
    model?: Partial<ModelConfig>
    skills?: SkillConfig[]
  }
  client?: Partial<Omit<ClientConfig, 'nodes'>> & {
    nodes?: Array<
      Partial<Omit<NodeConfig, 'auth'>> & Pick<NodeConfig, 'id' | 'name' | 'url'> & { auth?: Partial<AuthConfig> }
    >
  }
  logs?: Partial<LogsConfig>
}

/** Default skill advertised by a fresh profile. */
const DEFAULT_SKILLS: SkillConfig[] = [{
  id: 'general',
  name: 'General assistant',
  description: 'General-purpose coding, research, and operations tasks handled by DeepSeek Harness.',
  tags: ['general', 'coding', 'research'],
  examples: [],
}]

/** Default model route: empty fields defer to `agentDefaultModel`. */
const DEFAULT_MODEL: ModelConfig = { provider: '', model: '', reasoningEffort: '' }

/** Default inbound profile. */
const DEFAULT_SERVER: ServerConfig = {
  enabled: true,
  publicUrl: '',
  agentCardPath: DEFAULT_AGENT_CARD_PATH,
  agentCardAliases: [CANONICAL_AGENT_CARD_PATH],
  rpcPath: DEFAULT_RPC_PATH,
  name: 'DSH Agent',
  description: 'DeepSeek Harness agent exposed over the Agent2Agent protocol.',
  version: '1.0.0',
  auth: { mode: 'bearer', tokenEnv: DEFAULT_TOKEN_ENV, peers: [] },
  skills: DEFAULT_SKILLS,
  model: DEFAULT_MODEL,
  cwd: '',
  timeoutMs: DEFAULT_SERVER_TIMEOUT_MS,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  corsOrigins: [],
  providerOrganization: '',
  providerUrl: '',
  iconUrl: '',
  documentationUrl: '',
}

/** Default outbound profile. */
const DEFAULT_CLIENT: ClientConfig = {
  enabled: true,
  toolPrefix: 'a2a',
  discoverOnStart: true,
  allowPrivateHosts: true,
  requestTimeoutMs: DEFAULT_CLIENT_TIMEOUT_MS,
  nodes: [],
}

/** Default panel log profile. */
const DEFAULT_LOGS: LogsConfig = { capacity: DEFAULT_LOG_CAPACITY }

const PeerAuthSchema = z.object({
  id: z.string().required(),
  tokenEnv: z.string().default(''),
})

const AuthSchema = z.object({
  mode: z.union([z.const('none'), z.const('bearer')]).default('bearer'),
  tokenEnv: z.string().default(DEFAULT_TOKEN_ENV),
  peers: z.array(PeerAuthSchema).default([]),
})

const ModelSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

const SkillSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string().default(''),
  tags: z.array(String).default([]),
  examples: z.array(String).default([]),
})

const ServerSchema = z.object({
  enabled: z.boolean().default(true),
  publicUrl: z.string().default(''),
  agentCardPath: z.string().default(DEFAULT_AGENT_CARD_PATH),
  agentCardAliases: z.array(String).default([CANONICAL_AGENT_CARD_PATH]),
  rpcPath: z.string().default(DEFAULT_RPC_PATH),
  name: z.string().default('DSH Agent'),
  description: z.string().default('DeepSeek Harness agent exposed over the Agent2Agent protocol.'),
  version: z.string().default('1.0.0'),
  auth: AuthSchema.default(DEFAULT_SERVER.auth),
  skills: z.array(SkillSchema).default(DEFAULT_SKILLS),
  model: ModelSchema.default(DEFAULT_MODEL),
  cwd: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_SERVER_TIMEOUT_MS),
  maxBodyBytes: z.number().step(1).min(1).max(16 * 1024 * 1024).default(DEFAULT_MAX_BODY_BYTES),
  corsOrigins: z.array(String).default([]),
  providerOrganization: z.string().default(''),
  providerUrl: z.string().default(''),
  iconUrl: z.string().default(''),
  documentationUrl: z.string().default(''),
})

const NodeSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  url: z.string().required(),
  enabled: z.boolean().default(true),
  autoDiscover: z.boolean().default(true),
  auth: AuthSchema.default({ mode: 'bearer', tokenEnv: DEFAULT_TOKEN_ENV }),
})

const ClientSchema = z.object({
  enabled: z.boolean().default(true),
  toolPrefix: z.string().default('a2a'),
  discoverOnStart: z.boolean().default(true),
  allowPrivateHosts: z.boolean().default(true),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_CLIENT_TIMEOUT_MS),
  nodes: z.array(NodeSchema).default([]),
})

const LogsSchema = z.object({
  capacity: z.number().step(1).min(1).max(10_000).default(DEFAULT_LOG_CAPACITY),
})

/** Loader-validated configuration schema. */
export const Config = z.object({
  server: ServerSchema.default(DEFAULT_SERVER),
  client: ClientSchema.default(DEFAULT_CLIENT),
  logs: LogsSchema.default(DEFAULT_LOGS),
}) as z<ConfigInput, Config>

/**
 * Normalize one validated configuration.
 *
 * @param input - configuration already filled with schema defaults.
 * @returns a detached, normalized configuration safe to keep for the plugin lifetime.
 * @throws when a path, URL, skill id, model pair, or node id is contradictory.
 */
export function resolveConfig(input: Config): Config {
  const server = input.server
  const cardPath = normalizePath(server.agentCardPath, 'server.agentCardPath')
  const rpcPath = normalizePath(server.rpcPath, 'server.rpcPath')
  if (cardPath === rpcPath) {
    throw configError('server.rpcPath', 'must differ from server.agentCardPath')
  }
  const aliases = uniquePaths(server.agentCardAliases, 'server.agentCardAliases')
    .filter(path => path !== cardPath)
  const reserved = new Set([cardPath, ...aliases, HEALTH_PATH, ADMIN_STATE_PATH])
  if (reserved.has(rpcPath)) {
    throw configError('server.rpcPath', 'must not collide with a card, health, or admin path')
  }
  if (cardPath === HEALTH_PATH || cardPath === ADMIN_STATE_PATH) {
    throw configError('server.agentCardPath', 'must not collide with the health or admin path')
  }
  for (const alias of aliases) {
    if (alias === HEALTH_PATH || alias === ADMIN_STATE_PATH) {
      throw configError('server.agentCardAliases', 'must not collide with the health or admin path')
    }
  }

  const publicUrl = normalizeBaseUrl(server.publicUrl, 'server.publicUrl')
  const skills = normalizeSkills(server.skills)
  const model = normalizeModel(server.model)
  const cwd = server.cwd.trim()
  if (cwd.length > 0 && !isAbsolute(cwd)) throw configError('server.cwd', 'must be an absolute path when set')
  const auth = normalizeServerAuth(server.auth, 'server.auth')
  const corsOrigins = normalizeOrigins(server.corsOrigins, 'server.corsOrigins')

  const providerUrl = normalizeBaseUrl(server.providerUrl, 'server.providerUrl')
  const iconUrl = normalizeBaseUrl(server.iconUrl, 'server.iconUrl')
  const documentationUrl = normalizeBaseUrl(server.documentationUrl, 'server.documentationUrl')

  const client = input.client
  const toolPrefix = client.toolPrefix.trim()
  if (!/^[a-z][a-z0-9_]{0,15}$/.test(toolPrefix)) {
    throw configError('client.toolPrefix', 'must start with a lowercase letter and use 1-16 lowercase letters, digits, or underscores')
  }
  const nodes = normalizeNodes(client.nodes)

  return {
    server: {
      ...server,
      agentCardPath: cardPath,
      agentCardAliases: aliases,
      rpcPath,
      publicUrl,
      name: requireText(server.name, 'server.name'),
      description: requireText(server.description, 'server.description'),
      version: requireText(server.version, 'server.version'),
      auth,
      skills,
      model,
      cwd,
      corsOrigins,
      providerOrganization: server.providerOrganization.trim(),
      providerUrl,
      iconUrl,
      documentationUrl,
    },
    client: {
      ...client,
      toolPrefix,
      nodes,
    },
    logs: { capacity: input.logs.capacity },
  }
}

/** Build one configuration error naming its field. */
function configError(field: string, message: string): Error {
  return new Error(`dsh-a2a: ${field} ${message}`)
}

/** Trim and require non-empty text. */
function requireText(value: string, field: string): string {
  const text = value.trim()
  if (text.length === 0) throw configError(field, 'must not be empty')
  return text
}

/** Normalize one absolute pathname. */
export function normalizePath(value: string, field: string): string {
  let path = value.trim()
  if (!path.startsWith('/')) throw configError(field, 'must start with "/"')
  if (path.length > 512) throw configError(field, 'must be at most 512 characters')
  if (/[\s?#]/.test(path)) throw configError(field, 'must not contain whitespace, "?", or "#"')
  if (path.includes('//')) throw configError(field, 'must not contain "//"')
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/** Normalize and deduplicate a list of paths. */
function uniquePaths(values: string[], field: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of values) {
    const path = normalizePath(value, field)
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** Normalize an optional absolute base URL. */
export function normalizeBaseUrl(value: string, field: string): string {
  const text = value.trim()
  if (text.length === 0) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw configError(field, 'must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw configError(field, 'must use http or https')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw configError(field, 'must not embed credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw configError(field, 'must not contain a query or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

/** Normalize CORS origins to bare origins. */
function normalizeOrigins(values: string[], field: string): string[] {
  const seen = new Set<string>()
  const origins: string[] = []
  for (const value of values) {
    const text = value.trim()
    if (text.length === 0) continue
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw configError(field, `contains an invalid origin: ${JSON.stringify(text)}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw configError(field, `contains a non-http origin: ${JSON.stringify(text)}`)
    }
    if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
      throw configError(field, `must contain bare origins, not paths: ${JSON.stringify(text)}`)
    }
    const origin = url.origin
    if (seen.has(origin)) continue
    seen.add(origin)
    origins.push(origin)
  }
  return origins
}

/** Normalize skills and enforce unique ids. */
function normalizeSkills(values: SkillConfig[]): SkillConfig[] {
  if (values.length === 0) throw configError('server.skills', 'must contain at least one skill')
  const seen = new Set<string>()
  return values.map((skill, index) => {
    const id = skill.id.trim()
    if (id.length === 0 || id.length > 128) {
      throw configError(`server.skills[${index}].id`, 'must be 1-128 characters')
    }
    if (/\s/.test(id)) throw configError(`server.skills[${index}].id`, 'must not contain whitespace')
    if (seen.has(id)) throw configError(`server.skills[${index}].id`, `duplicates skill id ${JSON.stringify(id)}`)
    seen.add(id)
    const tags = dedupe(skill.tags.map(tag => tag.trim()).filter(tag => tag.length > 0))
    if (tags.length === 0) throw configError(`server.skills[${index}].tags`, 'must contain at least one tag')
    return {
      id,
      name: requireText(skill.name, `server.skills[${index}].name`),
      description: skill.description.trim(),
      tags,
      examples: skill.examples.map(example => example.trim()).filter(example => example.length > 0),
    }
  })
}

/** Normalize the optional model route. */
function normalizeModel(model: ModelConfig): ModelConfig {
  const provider = model.provider.trim()
  const id = model.model.trim()
  if ((provider.length === 0) !== (id.length === 0)) {
    throw configError('server.model', 'must set both provider and model, or neither')
  }
  return { provider, model: id, reasoningEffort: model.reasoningEffort.trim() }
}

/** Normalize one bearer block without a peer list. */
function normalizeAuthConfig(auth: AuthConfig, field: string): AuthConfig {
  const tokenEnv = auth.tokenEnv.trim()
  if (tokenEnv.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw configError(`${field}.tokenEnv`, 'must be a POSIX environment variable name')
  }
  return { mode: auth.mode, tokenEnv }
}

/** Normalize the inbound bearer block and its peer list. */
function normalizeServerAuth(auth: ServerAuthConfig, field: string): ServerAuthConfig {
  const base = normalizeAuthConfig(auth, field)
  const seen = new Set<string>()
  const peers = auth.peers.map((peer, index) => {
    const id = peer.id.trim()
    // The id also addresses its credential key (`dsh-a2a/peer-<id>`), whose
    // segment allows only lowercase letters, digits, and hyphens.
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) {
      throw configError(`${field}.peers[${index}].id`, 'must start with a lowercase letter and use 1-48 lowercase letters, digits, or "-"')
    }
    if (seen.has(id)) throw configError(`${field}.peers[${index}].id`, `duplicates peer id ${JSON.stringify(id)}`)
    seen.add(id)
    const peerEnv = peer.tokenEnv.trim()
    if (peerEnv.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(peerEnv)) {
      throw configError(`${field}.peers[${index}].tokenEnv`, 'must be a POSIX environment variable name')
    }
    return { id, tokenEnv: peerEnv }
  })
  return { ...base, peers }
}

/** Normalize node entries and enforce unique ids. */
function normalizeNodes(values: NodeConfig[]): NodeConfig[] {
  const seen = new Set<string>()
  return values.map((node, index) => {
    const id = node.id.trim()
    // A node id also lands in its credential key (`dsh-a2a/node-<id>`), whose
    // segments allow only lowercase letters, digits, and hyphens.
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) {
      throw configError(`client.nodes[${index}].id`, 'must start with a lowercase letter and use 1-48 lowercase letters, digits, or "-"')
    }
    if (seen.has(id)) throw configError(`client.nodes[${index}].id`, `duplicates node id ${JSON.stringify(id)}`)
    seen.add(id)
    return {
      id,
      name: requireText(node.name, `client.nodes[${index}].name`),
      url: normalizeBaseUrl(node.url, `client.nodes[${index}].url`),
      enabled: node.enabled,
      autoDiscover: node.autoDiscover,
      auth: normalizeAuthConfig(node.auth, `client.nodes[${index}].auth`),
    }
  })
}

/** Deduplicate strings while preserving order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
