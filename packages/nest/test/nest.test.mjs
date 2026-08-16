// Nest adapter tests, on both platforms.
//
// Three things make this an adapter rather than a re-export, and each is here:
//
//   1. `@Res()` instead of `@Sse()`, without which the §4.4 checkpoint header cannot be
//      written and a client can never be told it missed events.
//   2. `reply.hijack()` on the Fastify platform, without which Fastify serialises and ends
//      the response mid-stream.
//   3. `toNodeRequest`, without which `authorize` receives a request carrying none of what
//      the guards attached — on Fastify the raw request never sees `request.user`.
//
// The tests build controllers by calling Nest's decorators as the plain functions they
// are, the same way this repo's React tests use `createElement` rather than JSX: the test
// files stay runnable `.mjs` with no build step of their own.

import 'reflect-metadata'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Controller, Get, Inject, Injectable, Module, Req, Res, UseGuards } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { AGHOZ_HUB, AghozModule, createAghozHandler } from '../dist/index.js'

/** Applies a method decorator, which needs the descriptor Nest reads metadata onto. */
function decorateMethod(cls, method, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, method)
  for (const d of decorators) d(cls.prototype, method, descriptor)
}

/**
 * A guard standing in for the application's own authentication.
 *
 * The point is that it decorates the request Nest hands the controller. On the Fastify
 * platform that is the Fastify wrapper, and `request.raw` never sees it — which is the
 * whole reason `toNodeRequest` exists.
 */
function makeGuard() {
  class AuthGuard {
    canActivate(context) {
      const req = context.switchToHttp().getRequest()
      const url = new URL(req.url, 'http://x')
      req.user = { id: url.searchParams.get('u') ?? 'u_1', orgId: url.searchParams.get('org') ?? '42' }
      return true
    }
  }
  Injectable()(AuthGuard)
  return AuthGuard
}

/** Builds the controller the README tells people to write. */
function makeController(handlerOptions, guard) {
  class EventsController {
    constructor(hub) {
      this.hub = hub
      // Once, in the constructor — never per request. `revalidateMs` schedules an
      // interval per handler, so building one per request leaks a timer per connection.
      this.stream = createAghozHandler(hub, handlerOptions)
    }

    async events(req, res) {
      return this.stream(req, res)
    }

    cursor() {
      return { cursor: this.hub.cursor() }
    }
  }

  Inject(AGHOZ_HUB)(EventsController, undefined, 0)
  Controller('events')(EventsController)
  if (guard !== undefined) UseGuards(guard)(EventsController)

  decorateMethod(EventsController, 'events', Get())
  Req()(EventsController.prototype, 'events', 0)
  Res()(EventsController.prototype, 'events', 1)

  decorateMethod(EventsController, 'cursor', Get('cursor'))

  return EventsController
}

function makeModule(controller, aghozModule) {
  class AppModule {}
  Module({ imports: [aghozModule], controllers: [controller] })(AppModule)
  return AppModule
}

/**
 * Boots a real Nest application on the requested platform and returns its base URL.
 *
 * `platform` is 'express' or 'fastify'; everything else about the test is identical, which
 * is the claim worth testing.
 */
async function boot({ platform = 'express', handlerOptions = {}, guard, aghozModule } = {}) {
  const controller = makeController(handlerOptions, guard)
  const mod = makeModule(controller, aghozModule ?? AghozModule.forRoot({ keepAliveMs: 0 }))

  const app =
    platform === 'fastify'
      ? await NestFactory.create(mod, new FastifyAdapter(), { logger: false })
      : await NestFactory.create(mod, { logger: false })

  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  // Nest reports an IPv6 wildcard on some hosts; the tests dial IPv4 explicitly.
  const base = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1')

  return {
    app,
    base,
    hub: app.get(AGHOZ_HUB),
    async close() {
      await app.close()
    },
  }
}

/** Opens a stream and collects frames as they arrive. */
async function openStream(base, query) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/events?${query}`, { signal: ctrl.signal })
  const frames = []

  if (res.body) {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buffer = ''
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += dec.decode(value, { stream: true })
          let i
          while ((i = buffer.indexOf('\n\n')) !== -1) {
            frames.push(buffer.slice(0, i + 2))
            buffer = buffer.slice(i + 2)
          }
        }
      } catch {
        // aborted
      }
    })()
  }

  return {
    res,
    frames,
    async waitFor(match, ms = 3000) {
      const deadline = Date.now() + ms
      for (;;) {
        const hit = frames.find(match)
        if (hit !== undefined) return hit
        if (Date.now() > deadline) {
          throw new Error(`timed out; frames so far: ${JSON.stringify(frames)}`)
        }
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    close() {
      ctrl.abort()
    },
  }
}

// ---------------------------------------------------------------- both platforms

for (const platform of ['express', 'fastify']) {
  test(`[${platform}] the stream opens, replays and delivers live events`, async () => {
    const s = await boot({ platform })
    try {
      const cold = s.hub.cursor()
      await s.hub.publish('orders', { id: 'ord_1' })

      const stream = await openStream(s.base, `topics=orders&last_event_id=${cold}`)

      assert.equal(stream.res.status, 200)
      assert.match(stream.res.headers.get('content-type'), /text\/event-stream/)
      // §4.4 — the header `@Sse()` gives no way to write, and the reason this adapter
      // takes the response over instead of using it.
      assert.equal(stream.res.headers.get('last-event-id-checkpoint'), cold)

      await stream.waitFor((f) => f.includes('ord_1'))

      await s.hub.publish('orders', { id: 'ord_2' })
      const live = await stream.waitFor((f) => f.includes('ord_2'))
      assert.match(live, /^id: \d+-\d+\nevent: orders\n/)

      stream.close()
    } finally {
      await s.close()
    }
  })

  test(`[${platform}] the stream stays open — the framework does not end it`, async () => {
    const s = await boot({ platform })
    try {
      const stream = await openStream(s.base, 'topics=t')
      await stream.waitFor((f) => f.startsWith(':ok'))

      // Without `reply.hijack()` on Fastify this is where it fails: the response is
      // serialised and ended as soon as the route method returns, so a publish issued
      // afterwards never reaches the client even though everything above passed.
      await new Promise((r) => setTimeout(r, 150))
      await s.hub.publish('t', { n: 1 })
      await stream.waitFor((f) => f.includes('"n":1'))

      await s.hub.publish('t', { n: 2 })
      await stream.waitFor((f) => f.includes('"n":2'))

      stream.close()
    } finally {
      await s.close()
    }
  })

  test(`[${platform}] authorize sees what the guard attached, not the raw request`, async () => {
    const seen = []
    const s = await boot({
      platform,
      guard: makeGuard(),
      handlerOptions: {
        authorize: (req, topic) => {
          // On Fastify this is the wrapper; `req.raw.user` is undefined here. Passing the
          // raw request through would deny everything.
          seen.push(req.user?.orgId)
          return topic.startsWith(`org/${req.user.orgId}/`)
        },
        connectionKey: (req) => req.user.id,
      },
    })
    try {
      const stream = await openStream(s.base, 'topics=org/42/orders,org/99/orders&org=42')
      const denied = await stream.waitFor((f) => f.startsWith('event: ~denied'))

      assert.deepEqual(JSON.parse(denied.split('data: ')[1]).topics, ['org/99/orders'])
      assert.ok(seen.length > 0 && seen.every((org) => org === '42'), `saw ${JSON.stringify(seen)}`)

      stream.close()
    } finally {
      await s.close()
    }
  })

  test(`[${platform}] a request denied every topic is refused with 403`, async () => {
    const s = await boot({
      platform,
      guard: makeGuard(),
      handlerOptions: { authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`) },
    })
    try {
      const res = await fetch(`${s.base}/events?topics=org/99/orders&org=42`)
      assert.equal(res.status, 403)
      await res.body?.cancel().catch(() => {})
    } finally {
      await s.close()
    }
  })

  test(`[${platform}] the cursor route is an ordinary Nest route`, async () => {
    const s = await boot({ platform })
    try {
      await s.hub.publish('t', { n: 1 })
      const res = await fetch(`${s.base}/events/cursor`)
      // Returned as a plain object and serialised by Nest — no adapter involvement, which
      // is the point: only the stream route needs to escape the framework.
      assert.deepEqual(await res.json(), { cursor: s.hub.cursor() })
    } finally {
      await s.close()
    }
  })
}

// ---------------------------------------------------------------- module wiring

test('forRoot provides the hub through the injector', async () => {
  const s = await boot({})
  try {
    assert.equal(typeof s.hub.publish, 'function')
    assert.equal(typeof s.hub.stats, 'function')
  } finally {
    await s.close()
  }
})

test('forRoot accepts a hub the application already made', async () => {
  const { createHub } = await import('@aghoz/server')
  const existing = createHub({ keepAliveMs: 0 })
  const s = await boot({ aghozModule: AghozModule.forRoot({ hub: existing }) })
  try {
    assert.equal(s.hub, existing, 'the injected hub must be the one supplied')
  } finally {
    await s.close()
  }
})

test('forRootAsync builds the hub from an async factory', async () => {
  const s = await boot({
    aghozModule: AghozModule.forRootAsync({
      // The case that makes this necessary rather than tidy: `createRedisBackplane` is
      // async, so a multi-process deployment cannot build its hub synchronously.
      useFactory: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return { keepAliveMs: 0, maxHistoryBytes: 4096 }
      },
    }),
  })
  try {
    await s.hub.publish('t', { n: 1 })
    assert.equal(s.hub.stats().published, 1)
  } finally {
    await s.close()
  }
})

test('closing the application closes the hub and drops its connections', async () => {
  const s = await boot({})
  const stream = await openStream(s.base, 'topics=t')
  await stream.waitFor((f) => f.startsWith(':ok'))
  assert.equal(s.hub.stats().connections, 1)

  // Without the lifecycle hook the hub keeps its sockets and its keepalive interval, and
  // `app.close()` resolves while the process still cannot exit.
  await s.close()

  const stats = s.hub.stats()
  assert.equal(stats.connections, 0)
  assert.equal(stats.closed['hub-closed'], 1)
  stream.close()
})
