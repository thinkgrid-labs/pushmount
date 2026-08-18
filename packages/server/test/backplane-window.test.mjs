// The window inside §4.5's atomic block that only a backplane opens.
//
// With no backplane the block has no `await` in it, so a connection goes from
// registered to fully open in one tick and none of this is reachable. A backplane
// fetches shared history over the network, so the subscriber is registered — and
// therefore writable, droppable and countable — while the response still has no
// headers on it. Everything that can touch a connection in that state is tested here,
// because each one of them silently produced a subscriber that received nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '../dist/index.js'

/**
 * A backplane whose `replay` is slow on purpose, so the window is wide enough to aim
 * at. It reports nothing missed, which keeps every assertion here about the response
 * rather than about replay content.
 */
function slowBackplane(delayMs) {
  return {
    publish: async (_topic, _payload) => '1-0',
    onEvent: () => {},
    replay: async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      return { truncated: false, events: [] }
    },
    cursor: async () => '0-0',
    close: async () => {},
  }
}

async function boot(hubOptions) {
  const hub = createHub(hubOptions)
  const handler = hub.handler()
  const rejections = []

  const server = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/events') return res.writeHead(404).end()
    // A handler that rejects is the symptom this file exists to catch: it means the
    // response was written to by something else first.
    handler(req, res).catch((error) => rejections.push(error))
  })

  await new Promise((r) => server.listen(0, r))
  return {
    hub,
    rejections,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

test('a keepalive tick during replay does not steal the response headers', async () => {
  // 40ms keepalive against a 120ms replay, so a tick is certain to land inside it.
  const app = await boot({ backplane: slowBackplane(120), keepAliveMs: 40 })

  // An already-open connection, purely to start the shared keepalive interval — it is
  // started on first connect, so without this there is no timer to collide with.
  const idle = new AbortController()
  const first = await fetch(`${app.base}/events?topics=x`, { signal: idle.signal })
  void first.body.getReader().read()

  const res = await fetch(`${app.base}/events?topics=x`, {
    headers: { 'last-event-id': '1-0' },
  })

  // Without the guard, `res.write` flushed Node's implicit headers and all three of
  // these were lost — including the checkpoint, which is the whole reason this client
  // cannot be built on EventSource.
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(res.headers.get('x-accel-buffering'), 'no')
  assert.equal(res.headers.get('last-event-id-checkpoint'), '1-0')
  assert.deepEqual(app.rejections, [])

  idle.abort()
  await res.body.cancel()
  await app.close()
})

test('a client that aborts during replay leaves no subscriber behind', async () => {
  const app = await boot({ backplane: slowBackplane(150), keepAliveMs: 0 })

  const ctrl = new AbortController()
  const pending = fetch(`${app.base}/events?topics=x`, {
    headers: { 'last-event-id': '1-0' },
    signal: ctrl.signal,
  }).catch(() => {})

  // Abort while the handler is still awaiting shared history.
  await new Promise((r) => setTimeout(r, 40))
  ctrl.abort()
  await pending
  // Long enough for the replay to resolve and the handler to finish either way.
  await new Promise((r) => setTimeout(r, 200))

  // The teardown used to be registered *after* the await, so an abort inside the window
  // left a subscriber that nothing removed and whose pending queue grew with every
  // publish for the life of the process.
  assert.equal(app.hub.connectionCount(), 0)
  assert.deepEqual(app.rejections, [])

  await app.close()
})

test('a connection dropped during replay is answered 503, not a broken stream', async () => {
  const app = await boot({ backplane: slowBackplane(120), keepAliveMs: 0 })

  const pending = fetch(`${app.base}/events?topics=x`, { headers: { 'last-event-id': '1-0' } })
  await new Promise((r) => setTimeout(r, 40))

  // Whatever reaches for a live connection — logout, a permission change, shutdown —
  // can reach one that has not opened yet.
  app.hub.disconnect(() => true)

  const res = await pending
  assert.equal(res.status, 503)
  assert.equal(app.hub.connectionCount(), 0)
  assert.deepEqual(app.rejections, [])
  await res.body.cancel()

  await app.close()
})

test('hub.close owns the backplane lifecycle and closes it exactly once', async () => {
  let closes = 0
  const backplane = slowBackplane(0)
  backplane.close = async () => {
    closes++
  }
  const hub = createHub({ backplane, keepAliveMs: 0 })

  hub.close()
  hub.close()
  await Promise.resolve()

  assert.equal(closes, 1)
})
