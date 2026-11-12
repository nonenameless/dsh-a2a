/**
 * Inbound Bearer authentication.
 *
 * The token is read from the plugin's credential record first and from the
 * configured environment variable second. Comparison hashes both sides before
 * `timingSafeEqual`, so token length and prefix never influence timing.
 *
 * This module never logs the token, the Authorization header, or the resolved
 * credential record.
 *
 * @module @local/dsh-a2a/http/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config, PeerAuthConfig } from '../config.ts'
import type { A2AOwnerContext, CredentialsService } from '../dsh.ts'
import { INBOUND_CREDENTIAL_KEY, MAX_TOKEN_LENGTH, PEER_CREDENTIAL_PREFIX } from '../../shared/constants.ts'

/** Outcome of checking one inbound request. */
export type AuthDecision =
  | { ok: true; peer?: string }
  | { ok: false; reason: 'not-configured' | 'missing' | 'invalid' }

/**
 * Read one credential record's token value.
 *
 * @param ctx - plugin context carrying the optional credentials service.
 * @param key - credential key.
 * @returns the stored token, or undefined when absent.
 */
async function readStoredToken(ctx: A2AOwnerContext, key: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  if (credentials === undefined) return undefined
  try {
    const record = await credentials.readRecord(key)
    if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) return record.key
  } catch (error: unknown) {
    // A broken credential store must not silently fall through to an
    // environment value during a rotation; report and keep the store's
    // absence visible through `not-configured` unless the env fallback exists.
    ctx.logger.warn(`dsh-a2a: could not read credential record ${key}`, error)
  }
  return undefined
}

/**
 * Resolve the legacy single inbound token without exposing it to callers that
 * only need the configured/not-configured fact.
 *
 * @param ctx - plugin context carrying the optional credentials service.
 * @param config - resolved plugin configuration.
 * @returns the stored or environment token, or undefined when neither exists.
 */
export async function resolveInboundToken(ctx: A2AOwnerContext, config: Config): Promise<string | undefined> {
  const stored = await readStoredToken(ctx, INBOUND_CREDENTIAL_KEY)
  if (stored !== undefined) return stored

  const name = config.server.auth.tokenEnv
  if (name.length === 0) return undefined
  const value = process.env[name]
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return token.length === 0 ? undefined : token
}

/**
 * Resolve one configured peer's inbound token.
 *
 * @param ctx - plugin context carrying the optional credentials service.
 * @param config - resolved plugin configuration.
 * @param peer - configured peer.
 * @returns the stored or environment token, or undefined when neither exists.
 */
export async function resolvePeerToken(
  ctx: A2AOwnerContext,
  config: Config,
  peer: PeerAuthConfig,
): Promise<string | undefined> {
  const stored = await readStoredToken(ctx, `${PEER_CREDENTIAL_PREFIX}${peer.id}`)
  if (stored !== undefined) return stored
  if (peer.tokenEnv.length === 0) return undefined
  const value = process.env[peer.tokenEnv]
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return token.length === 0 ? undefined : token
}

/**
 * Parse one `Authorization: Bearer <token>` value.
 *
 * @param header - raw header value from `node:http`, or undefined.
 * @returns the token, or undefined for a missing/malformed/oversized header.
 */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const value = header.trim()
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH + 16) return undefined
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(value)
  if (match === null) return undefined
  const token = match[1]
  if (token === undefined || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined
  return token
}

/**
 * Compare two tokens without leaking length or prefix through timing.
 *
 * @param presented - token supplied by the caller.
 * @param expected - token configured for this server.
 * @returns whether they match exactly.
 */
export function timingSafeTokenEqual(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/**
 * Check one request against the configured inbound policy.
 *
 * @param ctx - plugin context carrying the optional credentials service.
 * @param config - resolved plugin configuration.
 * @param header - raw Authorization header, or undefined.
 * @returns the decision; `not-configured` means the server cannot admit any request yet.
 */
export async function verifyInboundBearer(
  ctx: A2AOwnerContext,
  config: Config,
  header: string | undefined,
): Promise<AuthDecision> {
  if (config.server.auth.mode === 'none') return { ok: true }

  const legacy = await resolveInboundToken(ctx, config)
  const peers = await Promise.all(config.server.auth.peers.map(async peer => ({
    id: peer.id,
    token: await resolvePeerToken(ctx, config, peer),
  })))
  const configured = legacy !== undefined || peers.some(peer => peer.token !== undefined)
  if (!configured) return { ok: false, reason: 'not-configured' }

  const presented = parseBearerToken(header)
  if (presented === undefined) return { ok: false, reason: 'missing' }

  if (legacy !== undefined && timingSafeTokenEqual(presented, legacy)) return { ok: true }
  for (const peer of peers) {
    if (peer.token !== undefined && timingSafeTokenEqual(presented, peer.token)) return { ok: true, peer: peer.id }
  }
  return { ok: false, reason: 'invalid' }
}
