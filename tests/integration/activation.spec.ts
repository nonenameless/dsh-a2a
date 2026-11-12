import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/host/index.ts'
import { Config } from '../../src/host/config.ts'
import type { A2AService } from '../../src/host/a2a-service.ts'
import type { WebHandlerRoute, WebResourceRoute } from '../../src/host/dsh.ts'

/** Let pending Cordis inject fibers run their callbacks. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('bundle activation', () => {
  it('publishes ctx.a2a and mounts the card, health, RPC, and admin routes', async () => {
    const routes = new Map<string, WebHandlerRoute | WebResourceRoute>()
    const ctx = new Context()
    ctx.provide('webServer', {
      getOrigin: () => 'http://127.0.0.1:3080',
      register(route: WebHandlerRoute | WebResourceRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    })

    apply(ctx, Config({}))
    await settle()

    expect(ctx.get('a2a')).toBeDefined()
    expect([...routes.keys()].sort()).toEqual([
      '/.well-known/agent-card.json',
      '/.well-known/agent.json',
      '/a2a',
      '/a2a/admin/inbound-token',
      '/a2a/admin/node-token',
      '/a2a/admin/nodes',
      '/a2a/admin/nodes/delete',
      '/a2a/admin/nodes/refresh',
      '/a2a/admin/peer-token',
      '/a2a/admin/state',
      '/a2a/health',
    ])

    const cardRoute = routes.get('/.well-known/agent.json')
    expect(cardRoute).toBeDefined()
    if (cardRoute === undefined || !('resource' in cardRoute)) throw new Error('card route is not a resource')
    const card = await (await cardRoute.resource(new Request('http://127.0.0.1:3080/.well-known/agent.json'))).json() as {
      name: string
      url: string
    }
    expect(card.name).toBe('DSH Agent')
    expect(card.url).toBe('http://127.0.0.1:3080/a2a')

    const healthRoute = routes.get('/a2a/health')
    if (healthRoute === undefined || !('resource' in healthRoute)) throw new Error('health route is not a resource')
    const health = await (await healthRoute.resource(new Request('http://127.0.0.1:3080/a2a/health'))).json() as {
      ok: boolean
    }
    expect(health.ok).toBe(true)

    expect(ctx.get('a2a')).toMatchObject({ config: { server: { rpcPath: '/a2a' } } })
    const service = ctx.get('a2a') as A2AService
    expect(service.rpcUrl()).toBe('http://127.0.0.1:3080/a2a')
  })

  it('registers no public routes when the server is disabled', async () => {
    const routes = new Map<string, WebHandlerRoute | WebResourceRoute>()
    const ctx = new Context()
    ctx.provide('webServer', {
      getOrigin: () => 'http://127.0.0.1:3080',
      register(route: WebHandlerRoute | WebResourceRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    })

    apply(ctx, Config({ server: { enabled: false } }))
    await settle()

    expect(routes.has('/a2a')).toBe(false)
    expect(routes.has('/.well-known/agent.json')).toBe(false)
    expect(routes.has('/a2a/admin/state')).toBe(true)
    expect(ctx.get('a2a')).toBeDefined()
  })
})
