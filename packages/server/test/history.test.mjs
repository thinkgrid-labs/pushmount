// Persistent history — replay that survives a restart.
//
// Two lives of a hub, sharing one store. The first publishes and dies; the second boots
// from the store and has to be indistinguishable from the first as far as a resuming
// client can tell. Everything here goes over a real socket, because the thing being
// checked is what the *client* is told.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub, createMemoryStore } from '../dist/index.js'

async function serve(hub) {
  const handler = hub.handler({})
  const cursorHandler = hub.cursorHandler()
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/events/cursor') return cursorHandler(req, res)
    return handler(req, res)
  })
  await new Promise((r) => server.listen(0, r))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

/** Opens a stream and reads whatever arrives in a short window. */
async function frames(url, headers = {}, ms = 400) {
  const res = await fetch(url, { headers })
  const checkpoint = res.headers.get('last-event-id-checkpoint')
  if (res.body === null) return { status: res.status, checkpoint, frames: [] }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true }), 120)),
    ])
    if (r.done) break
    buffer += dec.decode(r.value, { stream: true })
  }
  reader.cancel().catch(() => {})
  const out = buffer.split('\n\n').filter(Boolean).map((f) => `${f}\n\n`)
  return { status: res.status, checkpoint, frames: out }
}

// --------------------------------------------------------------------- the point

test('a restart replays from the store instead of reporting a gap', async () => {
  const store = createMemoryStore()

  const first = createHub({ keepAliveMs: 0, history: store })
  await first.ready()
  const a = await first.publish('t', 'one')
  await first.publish('t', 'two')
  await first.publish('t', 'three')
  first.close()

  // A new process, same store.
  const second = createHub({ keepAliveMs: 0, history: store })
  await second.ready()
  const s = await serve(second)
  try {
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': a.id })
    // Without a store this is `earliest` and the client refetches everything.
    assert.equal(got.checkpoint, a.id, 'the restored hub can vouch for the cursor')

    const data = got.frames.filter((f) => f.startsWith('id: '))
    assert.equal(data.length, 2, 'the two events after the cursor are replayed')
    assert.ok(data[0].includes('data: two'))
    assert.ok(data[1].includes('data: three'))
  } finally {
    await s.close()
  }
})

test('without a store the same restart is reported honestly as a gap', async () => {
  // The companion to the test above, and the more important of the two: persistence is
  // an optimisation, and the behaviour it optimises must already be correct.
  const first = createHub({ keepAliveMs: 0 })
  const a = await first.publish('t', 'one')
  await first.publish('t', 'two')
  first.close()

  const second = createHub({ keepAliveMs: 0 })
  const s = await serve(second)
  try {
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': a.id })
    assert.equal(got.checkpoint, 'earliest', 'a hub that cannot vouch must say so')
    const gap = got.frames.find((f) => f.startsWith('event: ~gap'))
    assert.ok(gap, `no gap frame; got ${JSON.stringify(got.frames)}`)
    assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'history-truncated')
  } finally {
    await s.close()
  }
})

test('the restored cursor is the newest stored id, so a later publish cannot collide', async () => {
  const store = createMemoryStore()
  const first = createHub({ keepAliveMs: 0, history: store })
  const last = await first.publish('t', 'v')
  first.close()

  const second = createHub({ keepAliveMs: 0, history: store, now: () => 1 })
  await second.ready()
  try {
    assert.equal(second.cursor(), last.id, 'restoration advances the sequence')
    // The clock is deliberately far behind the restored ids. §2.2 still has to hold.
    const next = await second.publish('t', 'after')
    assert.ok(next.id > last.id, `${next.id} must be newer than ${last.id}`)
  } finally {
    second.close()
  }
})

test('§6.0 origin survives a restart, so a tab still skips its own write on replay', async () => {
  const store = createMemoryStore()
  const first = createHub({ keepAliveMs: 0, history: store })
  const a = await first.publish('t', 'zero')
  await first.publish('t', 'mine', { origin: 'tab-7' })
  first.close()

  const second = createHub({ keepAliveMs: 0, history: store })
  await second.ready()
  const s = await serve(second)
  try {
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': a.id })
    const data = got.frames.filter((f) => f.startsWith('id: '))
    assert.equal(data.length, 1)
    assert.ok(data[0].includes('origin: tab-7'), `origin lost on replay: ${JSON.stringify(data[0])}`)
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------------------ boundaries

test('a store larger than the ring is trimmed on the way in, and the floor is right', async () => {
  const store = createMemoryStore()
  const big = createHub({ keepAliveMs: 0, history: store })
  const first = await big.publish('t', 'x'.repeat(120))
  await big.publish('t', 'x'.repeat(120))
  await big.publish('t', 'x'.repeat(120))
  big.close()

  // Restored into a ring far too small to hold all three.
  const small = createHub({ keepAliveMs: 0, history: store, maxHistoryBytes: 200 })
  await small.ready()
  const s = await serve(small)
  try {
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': first.id })
    // Eviction during restoration has to mark the floor exactly as it would have live,
    // or the hub under-reports and the client is silently short of events.
    assert.equal(got.checkpoint, 'earliest', 'restoration must not hide an eviction')
  } finally {
    await s.close()
  }
})

test('a store that fails to load leaves a hub that is honest rather than one that will not boot', async () => {
  const errors = []
  const broken = {
    load: () => Promise.reject(new Error('disk on fire')),
    append: () => {},
    close: () => Promise.resolve(),
  }
  const hub = createHub({ keepAliveMs: 0, history: broken, onError: (e) => errors.push(e) })
  await hub.ready()
  const s = await serve(hub)
  try {
    assert.equal(errors.length, 1)
    assert.equal(hub.stats().errors.history, 1)

    // Empty, which is exactly the state it would be in with no store — so the checkpoint
    // rule tells a resuming client the truth rather than the hub refusing to start.
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': '1755083412345-7' })
    assert.equal(got.status, 200)
    assert.equal(got.checkpoint, 'earliest')
  } finally {
    await s.close()
  }
})

test('a store that fails to write does not fail the publish', async () => {
  const errors = []
  const store = {
    load: () => Promise.resolve({ events: [] }),
    append: () => Promise.reject(new Error('disk full')),
    close: () => Promise.resolve(),
  }
  const hub = createHub({ keepAliveMs: 0, history: store, onError: (e) => errors.push(e) })
  await hub.ready()
  try {
    // The event reached subscribers; it has happened. Failing the publish would make a
    // durability problem look like a delivery problem.
    const ack = await hub.publish('t', 'v')
    assert.match(ack.id, /^\d+-\d+$/)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(hub.stats().errors.history, 1)
    assert.equal(hub.stats().errors.publish, 0, 'a write failure is not a publish failure')
  } finally {
    hub.close()
  }
})

test('a store and a backplane together are refused', async () => {
  // Both would record every event, but only the backplane's copy is ever read back — so
  // the store looks like durability and is not.
  assert.throws(
    () =>
      createHub({
        history: createMemoryStore(),
        backplane: {
          publish: async () => '1-0',
          onEvent: () => {},
          replay: async () => ({ truncated: false, events: [] }),
          cursor: async () => '0-0',
          close: async () => {},
        },
      }),
    /mutually exclusive/,
  )
})

test('the handler waits for restoration rather than serving an empty hub', async () => {
  // A request that lands mid-restore would see an empty ring and report a gap to a client
  // that had missed nothing — the false positive D6 exists to prevent.
  const seed = [
    { id: '1000-0', topic: 't', payload: 'one' },
    { id: '1000-1', topic: 't', payload: 'two' },
  ]
  const slow = {
    load: async () => {
      await new Promise((r) => setTimeout(r, 120))
      return { events: seed }
    },
    append: () => {},
    close: () => Promise.resolve(),
  }
  const hub = createHub({ keepAliveMs: 0, history: slow })
  // Deliberately NOT awaiting hub.ready() — the handler has to cover for it.
  const s = await serve(hub)
  try {
    const got = await frames(`${s.base}/events?topics=t`, { 'last-event-id': '1000-0' })
    assert.equal(got.checkpoint, '1000-0', 'served before restore finished')
    const data = got.frames.filter((f) => f.startsWith('id: '))
    assert.equal(data.length, 1)
    assert.ok(data[0].includes('data: two'))
  } finally {
    await s.close()
  }
})

test('everything published is written to the store, in order and with its id', async () => {
  const store = createMemoryStore()
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  try {
    const ids = []
    for (const v of ['one', 'two', 'three']) ids.push((await hub.publish('t', v)).id)
    await new Promise((r) => setTimeout(r, 20))

    assert.deepEqual(
      store.events.map((e) => [e.id, e.topic, e.payload]),
      ids.map((id, i) => [id, 't', ['one', 'two', 'three'][i]]),
    )
  } finally {
    hub.close()
  }
})

test('a store that reports what it dropped makes the hub report the gap', async () => {
  // A bounded store discards its oldest entries. The core's ring knows nothing about a
  // file compacted before this process booted, so only the store can say — and if it
  // does not, the hub answers "you missed nothing" to a client whose events were thrown
  // away by the very store meant to preserve them.
  const store = createMemoryStore(
    [
      { id: '1000-5', topic: 't', payload: 'five' },
      { id: '1000-6', topic: 't', payload: 'six' },
    ],
    '1000-4',
  )
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  const s = await serve(hub)
  try {
    const behind = await frames(`${s.base}/events?topics=t`, { 'last-event-id': '1000-2' })
    assert.equal(behind.checkpoint, 'earliest', 'below the floor is a gap')

    const at = await frames(`${s.base}/events?topics=t`, { 'last-event-id': '1000-4' })
    // Equal is not a gap, matching the ring's own rule: that is the event the client
    // already holds, and everything after it was restored.
    assert.equal(at.checkpoint, '1000-4', 'at the floor is not a gap')

    const above = await frames(`${s.base}/events?topics=t`, { 'last-event-id': '1000-5' })
    assert.equal(above.checkpoint, '1000-5', 'above the floor is not a gap')
  } finally {
    await s.close()
  }
})
