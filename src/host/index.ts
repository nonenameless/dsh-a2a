/**
 * Host entry for the DSH A2A bundle.
 *
 * Activation publishes `ctx.a2a`, then waits for `webServer` before mounting
 * the public and admin routes. The service is available even in a headless
 * composition that has no web server, so outbound tool registration can reuse
 * the same configuration and card builder later.
 *
 * @module @local/dsh-a2a
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as A2AConfig } from './config.ts'
import { createA2AService } from './a2a-service.ts'
import { registerPublicRoutes } from './http/routes.ts'
import { registerAdminRoutes } from './admin/routes.ts'

/** Loader row name. */
export const name = 'dsh-a2a'

/** Routes and tools are optional capabilities, so activation requires no service. */
export const inject: string[] = []

/** Loader-validated configuration schema. */
export { Config }
export type { A2AConfig }
export type { A2AAdminState, A2AHealth } from './a2a-service.ts'

/**
 * Activate the bundle.
 *
 * @param ctx - plugin context.
 * @param config - configuration validated and defaulted by the Loader.
 */
export function apply(ctx: Context, config: A2AConfig): void {
  const resolved = resolveConfig(config)
  const service = createA2AService(ctx, resolved)
  ctx.provide('a2a', service)
  ctx.effect(() => () => service.dispose(), 'dsh-a2a: task and agent lifetime')

  ctx.inject(['webServer'], (webCtx) => {
    if (resolved.server.enabled) registerPublicRoutes(webCtx, resolved, service)
    registerAdminRoutes(webCtx, service)
  })

  if (resolved.client.enabled) {
    ctx.inject(['tools'], () => {
      void service.startOutbound().catch((error: unknown) => {
        ctx.logger.warn('dsh-a2a: outbound setup failed', error)
      })
    })
  }
}
