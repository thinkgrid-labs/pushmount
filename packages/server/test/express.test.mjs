// P2's exit criterion: a real Express app, with compression middleware in front, still
// streams. This is the failure that works in development and hangs in staging, and the
// one §4.4's `no-transform` exists to prevent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import compression from 'compression'
import { createHub } from '../dist/index.js'

/** The quickstart, verbatim: session-ish middleware, then the mount, then a write path. */
async function bootExpressApp({ withCompression }) {
  const hub = createHub({ keepAliveMs: 0 })
  const app = express()

  if (withCompression) app.use(compression({ threshold: 0 }))

  // Stands in for the host application's existing auth middleware.
  app.use((req, _res, next) => {
    req.user = { id: req.query.u ?? 'u_1', orgId: req.query.org ?? '42' }
    next()
  })

  app.get('/events/cursor', hub.cursorHandler())
  app.get(
    '/events',
    hub.handler({
      authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
      connectionKey: (req) => req.user.id,
    }),
  )

  app.post('/api/orders', express.json(), (req, res) => {
    res.json({ ok: true })
    hub.publish(`org/${req.user.orgId}/orders`, req.body)
  })

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })

  return {
    hub,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
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

for (const withCompression of [false, true]) {
  const label = withCompression ? 'with compression middleware' : 'without middleware'

  test(`express: streams ${label}`, async () => {
    const app = await bootExpressApp({ withCompression })
    try {
      const res = await fetch(`${app.base}/events?topics=${encodeURIComponent('org/42/orders')}`)
      assert.equal(res.status, 200)
      // If a compressing proxy or middleware buffers the stream, the first frame never
      // arrives and this read times out — which is exactly the production symptom.
      assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')
      assert.equal(res.headers.get('content-encoding'), null, 'the stream must not be compressed')

      const ready = await readFrames(res, 1)
      assert.deepEqual(ready, [':ok\n\n'], 'stream did not flush — it is being buffered')
    } finally {
      await app.close()
    }
  })
}

test('express: a write through the existing API reaches an open subscriber', async () => {
  const app = await bootExpressApp({ withCompression: true })
  try {
    const res = await fetch(`${app.base}/events?topics=${encodeURIComponent('org/42/orders')}`)
    const reading = readFrames(res, 2)
    // Let the subscriber register before the write, as a real page would.
    await new Promise((r) => setTimeout(r, 50))

    await fetch(`${app.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ord_918', total: 4200 }),
    })

    const frames = await reading
    const data = frames.find((f) => f.startsWith('id: '))
    assert.ok(data, `no data frame; got ${JSON.stringify(frames)}`)
    assert.match(data, /event: org\/42\/orders\n/)
    assert.match(data, /data: \{"id":"ord_918","total":4200\}\n/)
  } finally {
    await app.close()
  }
})

test('express: inherited auth denies another org without any token layer', async () => {
  const app = await bootExpressApp({ withCompression: false })
  try {
    // req.user.orgId is 42; asking for org 99 is refused by the one-line callback.
    const res = await fetch(
      `${app.base}/events?topics=${encodeURIComponent('org/99/orders')}&org=42`,
    )
    assert.equal(res.status, 403)
    await res.body.cancel()
  } finally {
    await app.close()
  }
})

test('express: the per-key cap is keyed by the app’s own user id', async () => {
  const hub = createHub({ keepAliveMs: 0, maxConnectionsPerKey: 1 })
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: req.query.u }
    next()
  })
  app.get('/events', hub.handler({ connectionKey: (req) => req.user.id }))
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const first = await fetch(`${base}/events?topics=t&u=alice`)
    assert.equal(first.status, 200)
    const second = await fetch(`${base}/events?topics=t&u=alice`)
    assert.equal(second.status, 429)
    // A different user is unaffected.
    const other = await fetch(`${base}/events?topics=t&u=bob`)
    assert.equal(other.status, 200)

    await second.body.cancel()
    await first.body.cancel()
    await other.body.cancel()
  } finally {
    hub.close()
    await new Promise((r) => server.close(r))
  }
})
