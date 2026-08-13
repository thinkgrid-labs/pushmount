// §8.2 — the slow-consumer path, exercised with a socket that never reads.
//
// `fetch` cannot express this: it always drains. A client that stops draining is the
// real case — a backgrounded tab, a phone on a dying connection — and the requirement
// is that the server disconnects it rather than letting it accumulate a slowly
// diverging view of the world.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createHub } from '../dist/index.js'

test('a subscriber that never drains is disconnected, not starved', async () => {
  const hub = createHub({ keepAliveMs: 0, maxBufferBytes: 1024 })
  const handler = hub.handler()
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port

  // A raw socket that sends the request and then never reads a byte.
  const sock = connect(port, '127.0.0.1')
  await new Promise((r) => sock.once('connect', r))
  sock.pause()
  sock.write('GET /events?topics=t HTTP/1.1\r\nHost: localhost\r\n\r\n')

  const registered = Date.now() + 2000
  while (hub.connectionCount() === 0 && Date.now() < registered) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(hub.connectionCount(), 1, 'subscriber should be registered')

  // Publish until the kernel buffer and Node's writable queue are both full. The
  // payload is large so this terminates quickly rather than looping thousands of times.
  const big = 'x'.repeat(64 * 1024)
  const deadline = Date.now() + 5000
  while (hub.connectionCount() > 0 && Date.now() < deadline) {
    await hub.publish('t', big)
  }

  assert.equal(
    hub.connectionCount(),
    0,
    'a subscriber past maxBufferBytes must be dropped, not accumulated',
  )

  sock.destroy()
  hub.close()
  await new Promise((r) => server.close(r))
})
