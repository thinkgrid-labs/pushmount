// Fastify adapter tests.
//
// The two things that make this an adapter rather than a re-export are both here:
// `reply.hijack()`, without which Fastify ends the response mid-stream, and
// `toNodeRequest`, without which `authorize` receives a request with none of Fastify's
// decorations on it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createHub } from '@aghoz/server'
import { registerAghoz } from '../dist/index.js'

async function boot({ authorize, connectionKey } = {}) {
  const hub = createHub({ keepAliveMs: 0 })
  const app = Fastify()

  // Stands in for whatever the app already uses; the point is that it decorates the
  // Fastify request, not the raw one.
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (request) => {
    request.user = { id: request.query.u ?? 'u_1', orgId: request.query.org ?? '42' }
  })

  await registerAghoz(app, {
    hub,
    ...(authorize !== undefined && { authorize }),
    ...(connectionKey !== undefined && { connectionKey }),
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  return {
    hub,
    base: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      hub.close()
      await app.close()
    },
  }
}

async function readFrames(res, want, ms = 3000) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const frames = []
  let buffer = ''
  const deadline = Date.now() + ms
  while (frames.length < want && Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += dec.decode(value, { stream: true })
    let i
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      frames.push(buffer.slice(0, i + 2))
      buffer = buffer.slice(i + 2)
    }
  }
  reader.cancel().catch(() => {})
  return frames
}

test('the stream stays open — reply.hijack() keeps Fastify from ending it', async () => {
  const s = await boot()
  try {
    const res = await fetch(`${s.base}/events?topics=t`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^text\/event-stream/)
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')

    // Without hijack this response is already finished and the read returns nothing.
    const frames = await readFrames(res, 1)
    assert.deepEqual(frames, [':ok\n\n'])
  } finally {
    await s.close()
  }
})

test('a publish reaches a Fastify subscriber', async () => {
  const s = await boot()
  try {
    const res = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/42/orders')}`)
    const reading = readFrames(res, 2)
    await new Promise((r) => setTimeout(r, 50))

    await s.hub.publish('org/42/orders', { id: 'ord_918' })
    const frames = await reading
    const data = frames.find((f) => f.startsWith('id: '))
    assert.ok(data, `no data frame; got ${JSON.stringify(frames)}`)
    assert.match(data, /event: org\/42\/orders\n/)
    assert.match(data, /data: \{"id":"ord_918"\}\n/)
  } finally {
    await s.close()
  }
})

test('authorize sees the Fastify request, decorations and all', async () => {
  // This is the whole reason toNodeRequest exists. request.raw has no `user` on it, so
  // passing the raw request here would deny everything — or worse, allow everything.
  const seen = []
  const s = await boot({
    authorize: (req, topic) => {
      seen.push({ hasUser: req.user !== null && req.user !== undefined, topic })
      return topic.startsWith(`org/${req.user.orgId}/`)
    },
  })
  try {
    const ok = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/42/a')}&org=42`)
    assert.equal(ok.status, 200)
    await ok.body.cancel()

    const denied = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/99/a')}&org=42`)
    assert.equal(denied.status, 403)
    await denied.body.cancel()

    assert.ok(seen.length >= 2)
    assert.ok(seen.every((s) => s.hasUser), 'authorize must receive the decorated request')
  } finally {
    await s.close()
  }
})

test('connectionKey is keyed by the app’s own user id', async () => {
  const hub = createHub({ keepAliveMs: 0, maxConnectionsPerKey: 1 })
  const app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (request) => {
    request.user = { id: request.query.u }
  })
  await registerAghoz(app, { hub, connectionKey: (req) => req.user.id })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${app.server.address().port}`

  try {
    const first = await fetch(`${base}/events?topics=t&u=alice`)
    assert.equal(first.status, 200)
    const second = await fetch(`${base}/events?topics=t&u=alice`)
    assert.equal(second.status, 429)
    const other = await fetch(`${base}/events?topics=t&u=bob`)
    assert.equal(other.status, 200)

    await first.body.cancel()
    await second.body.cancel()
    await other.body.cancel()
  } finally {
    hub.close()
    await app.close()
  }
})

test('the cursor route is registered alongside the stream', async () => {
  const s = await boot()
  try {
    const before = await (await fetch(`${s.base}/events/cursor`)).json()
    assert.equal(before.cursor, '0-0')

    const ack = await s.hub.publish('t', 'v')
    const after = await (await fetch(`${s.base}/events/cursor`)).json()
    assert.equal(after.cursor, ack.id)
  } finally {
    await s.close()
  }
})

test('teardown removes the subscriber when the client goes away', async () => {
  const s = await boot()
  try {
    const controller = new AbortController()
    const res = await fetch(`${s.base}/events?topics=t`, { signal: controller.signal })
    await readFrames(res, 1)
    assert.equal(s.hub.connectionCount(), 1)

    controller.abort()
    const deadline = Date.now() + 2000
    while (s.hub.connectionCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(s.hub.connectionCount(), 0, 'hijacked responses must still be cleaned up')
  } finally {
    await s.close()
  }
})
