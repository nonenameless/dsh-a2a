/**
 * Minimal structural views of the DSH Host services this plugin consumes.
 *
 * These are deliberately narrower than the packages' public types: the plugin
 * only calls the members below, and keeping the declarations local lets the
 * bundle compile without making every optional DSH package a build-time
 * dependency. The runtime contract is still the real service; a signature
 * change surfaces here as a type error at the call site.
 *
 * @module @local/dsh-a2a/dsh
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'

/** Logger subset used by Host modules and test doubles. */
export interface LoggerLike {
  warn(message: string, error?: unknown): void
}

/**
 * Read-only view of the Cordis service store.
 *
 * `get` returns the registered service value, so the result is intentionally
 * `any`: callers narrow it to the structural interface they consume. Cordis
 * offers no generic form.
 */
export interface ServiceReader {
  // oxlint-disable-next-line typescript/no-explicit-any -- Cordis's service store is dynamically typed; callers cast to the narrow interface they use.
  get(name: string): any
}

/** Minimal context needed by the A2A capability and inbound authentication. */
export interface A2AOwnerContext extends ServiceReader {
  logger: LoggerLike
}

/** Context needed by route registration: service lookup, logging, and effect scope. */
export interface RouteContext extends A2AOwnerContext {
  effect(execute: () => Generator<() => void, void, void>, label?: string): unknown
}

/** One route answered directly by a handler that owns the response. */
export interface WebHandlerRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One route answered by a Fetch-shaped resource (GET/HEAD and in-process reads). */
export interface WebResourceRoute {
  kind: 'exact' | 'prefix'
  path: string
  resource: (request: Request, peer?: unknown) => Promise<Response>
}

/** The `ctx.webServer` surface this plugin registers against. */
export interface WebServerService {
  /** Bound origin such as `http://127.0.0.1:3080`, without a trailing slash. */
  getOrigin(): string
  register(route: WebHandlerRoute | WebResourceRoute): () => void
}

/** The `ctx.connection` surface used to admit same-origin browser requests. */
export interface ConnectionService {
  /**
   * Admit one browser request, writing a redirect/401 itself when it refuses.
   * @param req - incoming request.
   * @param res - response that may receive the refusal.
   * @returns whether the request may proceed.
   */
  authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean
}

/** Stored credential record subset read by this plugin. */
export interface CredentialRecordLike {
  kind?: string
  key?: string
  payload?: unknown
}

/** The `ctx.credentials` surface used for inbound and outbound tokens. */
export interface CredentialsService {
  readRecord(key: string): Promise<CredentialRecordLike | undefined>
  modifyRecord?(
    key: string,
    mutate: (current: CredentialRecordLike | undefined) => CredentialRecordLike | undefined,
  ): Promise<unknown>
  deleteRecord?(key: string): Promise<void>
}

/** The `ctx.tools` surface used to register remote skills. */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** The `ctx.configEditor` surface used to persist node edits. */
export interface ConfigEditorService {
  edit(entry: unknown, update: (current: Config) => Config): Promise<unknown>
}

/** The `ctx.agentDefaultModel` surface used when Config names no route. */
export interface AgentDefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/** The `ctx.agents` surface used by inbound tasks. */
export interface AgentsService {
  get(id: SessionId): Agent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}
