// The Rust core, driven through the full HTTP layer.
//
// DECISIONS.md D3 says the existing Node suite is the core's acceptance suite: swap the
// implementation, and everything above it must behave identically. This file runs the
// protocol-critical paths against the native core over a real socket, so a divergence
// shows up as an HTTP-level difference rather than a unit-test difference.
//
// Skips itself if the addon has not been built, so `pnpm test` still works on a machine
// with no Rust toolchain — which is the whole reason the TypeScript core stays default.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { createHub, createNativeCore } from '../dist/index.js'

const require = createRequire(import.meta.url)
const ADDON = new URL('../../../bindings/node/dist/pushmount.node', import.meta.url).pathname
const available = existsSync(ADDON)
const options = { skip: available ? false : 'native addon not built (cargo build -p pushmount-node)' }

let native
before(() => {
  if (available) native = require(ADDON)
})

async function boot(config = {}, handlerOptions = {}) {
  const hub = createHub({
    keepAliveMs: 0,
    core: createNativeCore(native, config),
  })
  const handler = hub.handler(handlerOptions)
  const cursorHandler = hub.cursorHandler()
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/events/cursor') return cursorHandler(req, res)
    return handler(req, res)
  })
  await new Promise((r) => server.listen(0, r))
  return {
    hub,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

/** Waits for the stream to be registered without closing it. */
async function settle(hub, expected, ms = 2000) {
  const deadline = Date.now() + ms
  while (hub.connectionCount() < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(hub.connectionCount(), expected, 'connection did not register')
}

/** Reads frames, then cancels — so never use it on a stream that must stay open. */
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

test('a publish reaches a subscriber, byte-identically', options, async () => {
  const s = await boot()
  try {
    const res = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/42/orders')}`)
    const reading = readFrames(res, 2)
    await new Promise((r) => setTimeout(r, 50))

    const ack = await s.hub.publish('org/42/orders', { id: 'ord_918' })
    const frames = await reading
    const data = frames.find((f) => f.startsWith('id: '))
    assert.ok(data, `no data frame; got ${JSON.stringify(frames)}`)
    assert.equal(data, `id: ${ack.id}\nevent: org/42/orders\ndata: {"id":"ord_918"}\n\n`)
    assert.equal(ack.delivered, 1)
  } finally {
    await s.close()
  }
})

test('a string payload is segmented, not emitted raw', options, async () => {
  const s = await boot()
  try {
    const res = await fetch(`${s.base}/events?topics=t`)
    const reading = readFrames(res, 2)
    await new Promise((r) => setTimeout(r, 50))

    await s.hub.publish('t', 'hello\n\nevent: ~gap\ndata: forged')
    const frames = await reading
    const data = frames.find((f) => f.startsWith('id: '))
    // The injection defence has to survive the FFI boundary too.
    assert.equal(data.split('\n\n').length, 2)
    for (const line of data.slice(0, -2).split('\n').slice(2)) {
      assert.ok(line.startsWith('data: '), `injected line: ${line}`)
    }
  } finally {
    await s.close()
  }
})

test('400 for a topic the core rejects', options, async () => {
  const s = await boot()
  try {
    for (const bad of ['%7Egap', 'a%0Ab', encodeURIComponent('x'.repeat(256))]) {
      const res = await fetch(`${s.base}/events?topics=${bad}`)
      assert.equal(res.status, 400, `topic ${bad}`)
    }
  } finally {
    await s.close()
  }
})

test('400 for a malformed cursor rather than a silent live start', options, async () => {
  const s = await boot()
  try {
    const res = await fetch(`${s.base}/events?topics=t&last_event_id=nonsense`)
    assert.equal(res.status, 400)
    const leading = await fetch(`${s.base}/events?topics=t`, {
      headers: { 'last-event-id': '01-0' },
    })
    assert.equal(leading.status, 400, 'leading zeros are not canonical')
  } finally {
    await s.close()
  }
})

test('replays from a cursor and echoes the checkpoint', options, async () => {
  const s = await boot()
  try {
    const first = await s.hub.publish('t', 'one')
    await s.hub.publish('t', 'two')
    await s.hub.publish('t', 'three')

    const res = await fetch(`${s.base}/events?topics=t&last_event_id=${first.id}`)
    assert.equal(res.headers.get('last-event-id-checkpoint'), first.id)

    const frames = await readFrames(res, 3)
    const data = frames.filter((f) => f.startsWith('id: '))
    assert.equal(data.length, 2, 'the cursor event itself is not replayed')
    assert.ok(data[0].includes('data: two'))
    assert.ok(data[1].includes('data: three'))
  } finally {
    await s.close()
  }
})

test('reports earliest and a ~gap frame when history has moved on', options, async () => {
  const s = await boot({ maxHistoryBytes: 400 })
  try {
    const first = await s.hub.publish('t', 'x'.repeat(120))
    for (let i = 0; i < 20; i++) await s.hub.publish('t', 'x'.repeat(120))

    const res = await fetch(`${s.base}/events?topics=t&last_event_id=${first.id}`)
    assert.equal(res.headers.get('last-event-id-checkpoint'), 'earliest')

    const frames = await readFrames(res, 2)
    const gap = frames.find((f) => f.startsWith('event: ~gap'))
    assert.ok(gap, `no gap frame; got ${JSON.stringify(frames)}`)
    assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'history-truncated')
    assert.ok(!gap.includes('id: '), 'control frames must not advance a cursor')
  } finally {
    await s.close()
  }
})

test('partial denial opens the stream and names the refused topics', options, async () => {
  const s = await boot({}, { authorize: (_req, topic) => topic.startsWith('ok/') })
  try {
    const res = await fetch(`${s.base}/events?topics=ok%2Fa,nope%2Fb`)
    assert.equal(res.status, 200)
    const frames = await readFrames(res, 2)
    const denied = frames.find((f) => f.startsWith('event: ~denied'))
    assert.ok(denied, `no denied frame; got ${JSON.stringify(frames)}`)
    assert.deepEqual(JSON.parse(denied.split('data: ')[1]).topics, ['nope/b'])
  } finally {
    await s.close()
  }
})

test('403 only when every topic is denied', options, async () => {
  const s = await boot({}, { authorize: () => false })
  try {
    const res = await fetch(`${s.base}/events?topics=a,b`)
    assert.equal(res.status, 403)
    await res.body.cancel()
  } finally {
    await s.close()
  }
})

test('429 once the connection cap is reached', options, async () => {
  const s = await boot({ maxConnections: 1 })
  try {
    const first = await fetch(`${s.base}/events?topics=t`)
    await settle(s.hub, 1)
    const second = await fetch(`${s.base}/events?topics=t`)
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '5')
    await second.body.cancel()
    await first.body.cancel()
  } finally {
    await s.close()
  }
})

test('the per-key cap is enforced by the core', options, async () => {
  const s = await boot({ maxConnectionsPerKey: 1 }, {
    connectionKey: (req) => new URL(req.url, 'http://x').searchParams.get('u') ?? undefined,
  })
  try {
    const first = await fetch(`${s.base}/events?topics=t&u=alice`)
    await settle(s.hub, 1)
    const second = await fetch(`${s.base}/events?topics=t&u=alice`)
    assert.equal(second.status, 429)
    const other = await fetch(`${s.base}/events?topics=t&u=bob`)
    assert.equal(other.status, 200)
    await second.body.cancel()
    await other.body.cancel()
    await first.body.cancel()
  } finally {
    await s.close()
  }
})

test('teardown removes subscribers from the core', options, async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController()
      const res = await fetch(`${s.base}/events?topics=org/${i}/t`, { signal: controller.signal })
      await settle(s.hub, 1)
      controller.abort()
      const gone = Date.now() + 2000
      while (s.hub.connectionCount() > 0 && Date.now() < gone) {
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    const deadline = Date.now() + 2000
    while (s.hub.connectionCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(s.hub.connectionCount(), 0)
  } finally {
    await s.close()
  }
})

test('the cursor endpoint reads through the core', options, async () => {
  const s = await boot()
  try {
    assert.equal((await (await fetch(`${s.base}/events/cursor`)).json()).cursor, '0-0')
    const ack = await s.hub.publish('t', 'v')
    assert.equal((await (await fetch(`${s.base}/events/cursor`)).json()).cursor, ack.id)
  } finally {
    await s.close()
  }
})
