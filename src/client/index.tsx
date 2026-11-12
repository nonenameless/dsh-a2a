/**
 * Browser entry for the A2A settings page.
 *
 * The module registers one `settings.section` contribution. It deliberately
 * has no Cordis client-service dependencies beyond the slot registry: the page
 * reads the same-origin admin API directly.
 *
 * @module @local/dsh-a2a/client
 */

import { A2ASection } from './A2ASection.tsx'

/** Minimal slot registry surface used by this module. */
interface SlotsLike {
  inject(name: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Minimal browser plugin context. */
interface ClientContext {
  slots: SlotsLike
}

/** Required browser service. */
export const inject = ['slots']

/**
 * Mount the settings page.
 *
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'a2a',
    order: 60,
    label: () => 'A2A',
  }, A2ASection))
}
