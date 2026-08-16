// Observability counters — `hub.stats()`.
//
// These run over a real socket like the rest of the handler suite, because the counters
// that matter are the ones attributing a *close*, and a close is a socket event. The
// tests below are mostly about attribution rather than arithmetic: a total that is right
// but filed under the wrong cause sends whoever reads it after the wrong problem, which
// is worse than not measuring at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '../dist/index.js'

async function boot(hubOptions = {}, handlerOptions = {}) {
  const hub = createHub({ keepAliveMs: 0, onError: () => {}, ...hubOptions })
  const handler = hub.handler(handlerOptions)

  const server = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/events') return res.writeHead(404).end()
    handler(req, res)
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

/** Opens a stream and resolves once the server has actually answered. */
async function openStream(base, query, init = {}) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/events?${query}`, { ...init, signal: ctrl.signal })
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
    async waitFor(match, ms = 1500) {
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

/** Polls until `predicate(stats)` holds — close attribution lands on a socket event. */
async function until(hub, predicate, ms = 1500) {
  const deadline = Date.now() + ms
  for (;;) {
    const stats = hub.stats()
    if (predicate(stats)) return stats
    if (Date.now() > deadline) {
      throw new Error(`timed out; stats: ${JSON.stringify(stats)}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------- shape

test('a fresh hub reports zeroes, and every bucket exists', async () => {
  const s = await boot()
  try {
    const stats = s.hub.stats()

    // Every key is present from the start. A counter that springs into existence on
    // first use reads as a gap in a time series rather than as a zero.
    assert.deepEqual(Object.keys(stats.closed).sort(), [
      'client',
      'evicted',
      'hub-closed',
      'revalidated',
      'slow-consumer',
    ])
    assert.deepEqual(Object.keys(stats.rejected).sort(), [
      'authorize-error',
      'bad-request',
      // A 500 from the core is kept apart from a 500 out of `authorize`: different
      // faults, different owners, and folding them together hides whichever is rarer.
      'core-error',
      'over-capacity',
      'unauthorized',
      'unavailable',
    ])
    assert.deepEqual(Object.keys(stats.errors).sort(), [
      'authorize',
      'backplane',
      'core',
      'history',
      'publish',
    ])

    for (const n of [
      stats.connections,
      stats.opening,
      stats.bufferedBytes,
      stats.opened,
      stats.published,
      stats.received,
      stats.delivered,
      stats.replayed,
      stats.denied,
      stats.truncated,
      ...Object.values(stats.closed),
      ...Object.values(stats.rejected),
      ...Object.values(stats.errors),
    ]) {
      assert.equal(n, 0)
    }

    assert.ok(JSON.parse(JSON.stringify(stats)), 'must survive serialisation')
  } finally {
    await s.close()
  }
})

test('a snapshot is a copy, not a live view', async () => {
  const s = await boot()
  try {
    const before = s.hub.stats()
    await s.hub.publish('a', { n: 1 })

    // Holding a snapshot and diffing against the next one is the intended usage; it
    // only works if the nested objects were copied rather than handed out by reference.
    assert.equal(before.published, 0)
    assert.equal(s.hub.stats().published, 1)

    const closedBefore = before.closed
    await openStream(s.base, 'topics=a').then((c) => c.close())
    await until(s.hub, (st) => st.closed.client === 1)
    assert.equal(closedBefore.client, 0)
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- traffic

test('connections, opened and delivered follow real traffic', async () => {
  const s = await boot()
  try {
    const a = await openStream(s.base, 'topics=news')
    const b = await openStream(s.base, 'topics=news')
    await a.waitFor((f) => f.startsWith(':ok'))
    await b.waitFor((f) => f.startsWith(':ok'))

    await until(s.hub, (st) => st.connections === 2)
    assert.equal(s.hub.stats().opened, 2)
    assert.equal(s.hub.stats().opening, 0, 'no backplane means no open window')

    await s.hub.publish('news', { n: 1 })
    await a.waitFor((f) => f.includes('"n":1'))

    const stats = s.hub.stats()
    // One publish, two subscribers: `published` counts the event and `delivered` counts
    // the writes. Conflating them is what makes a fan-out metric useless.
    assert.equal(stats.published, 1)
    assert.equal(stats.delivered, 2)

    // A publish to a topic nobody holds still happened.
    await s.hub.publish('other', { n: 2 })
    assert.equal(s.hub.stats().published, 2)
    assert.equal(s.hub.stats().delivered, 2)

    a.close()
    b.close()
  } finally {
    await s.close()
  }
})

test('a failed publish counts as an error and not as a publish', async () => {
  const s = await boot()
  try {
    await assert.rejects(() => s.hub.publish('~reserved', { n: 1 }))
    await assert.rejects(() => s.hub.publish('ok', { n: 1 }, { origin: 'a\nb' }))

    const stats = s.hub.stats()
    assert.equal(stats.published, 0, 'a rejected publish reached nobody')
    assert.equal(stats.errors.publish, 2)
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- close attribution

test('a client going away is attributed to the client', async () => {
  const s = await boot()
  try {
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    c.close()

    const stats = await until(s.hub, (st) => st.connections === 0)
    assert.equal(stats.closed.client, 1)
    assert.equal(stats.closed.evicted, 0)
    assert.equal(stats.closed['hub-closed'], 0)
  } finally {
    await s.close()
  }
})

test('disconnect() is attributed to eviction, not to the client close it causes', async () => {
  const s = await boot()
  try {
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.connections === 1)

    assert.equal(s.hub.disconnect(() => true), 1)

    // Ending the response fires `close` on the socket a tick later. If `drop` were not
    // idempotent — or counted after deleting — that event would overwrite `evicted`
    // with `client` and every deliberate eviction would be invisible.
    await new Promise((r) => setTimeout(r, 100))
    const stats = s.hub.stats()
    assert.equal(stats.closed.evicted, 1)
    assert.equal(stats.closed.client, 0)
    assert.equal(stats.connections, 0)
    c.close()
  } finally {
    await s.close()
  }
})

test('hub.close() is attributed to the hub', async () => {
  const s = await boot()
  try {
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.connections === 1)

    s.hub.close()
    const stats = s.hub.stats()
    assert.equal(stats.closed['hub-closed'], 1)
    assert.equal(stats.closed.client, 0)
    c.close()
  } finally {
    await s.close()
  }
})

test('revalidation drops are their own bucket', async () => {
  let permit = true
  const s = await boot({}, { authorize: () => permit, revalidateMs: 20 })
  try {
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.connections === 1)

    permit = false
    const stats = await until(s.hub, (st) => st.closed.revalidated === 1)
    assert.equal(stats.closed.client, 0)
    assert.equal(stats.connections, 0)
    c.close()
  } finally {
    await s.close()
  }
})

test('an authorize that throws during revalidation is counted as an authorize error', async () => {
  let boom = false
  const s = await boot(
    {},
    {
      authorize: () => {
        if (boom) throw new Error('db down')
        return true
      },
      revalidateMs: 20,
    },
  )
  try {
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.connections === 1)

    boom = true
    const stats = await until(s.hub, (st) => st.closed.revalidated === 1)
    assert.ok(stats.errors.authorize >= 1)
    c.close()
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- rejection buckets

test('rejections are bucketed by cause', async () => {
  const s = await boot(
    { maxConnections: 1 },
    { authorize: (_req, topic) => topic !== 'secret' },
  )
  try {
    // 400 — no topics, and a topic that violates §3.
    assert.equal((await fetch(`${s.base}/events`)).status, 400)
    assert.equal((await fetch(`${s.base}/events?topics=%7Egap`)).status, 400)
    // 400 — a malformed cursor is a rejection, never a silent downgrade.
    assert.equal((await fetch(`${s.base}/events?topics=a&last_event_id=nope`)).status, 400)
    // 403 — every requested topic denied.
    assert.equal((await fetch(`${s.base}/events?topics=secret`)).status, 403)

    let stats = s.hub.stats()
    assert.equal(stats.rejected['bad-request'], 3)
    assert.equal(stats.rejected.unauthorized, 1)
    assert.equal(stats.opened, 0, 'nothing here became a stream')

    // 429 — the second connection exceeds maxConnections.
    const c = await openStream(s.base, 'topics=a')
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.connections === 1)
    assert.equal((await fetch(`${s.base}/events?topics=a`)).status, 429)
    assert.equal(s.hub.stats().rejected['over-capacity'], 1)
    c.close()

    // 503 — the hub is closed.
    s.hub.close()
    assert.equal((await fetch(`${s.base}/events?topics=a`)).status, 503)
    stats = s.hub.stats()
    assert.equal(stats.rejected.unavailable, 1)
  } finally {
    await s.close()
  }
})

test('an authorize that throws at connect is a 500 in its own bucket', async () => {
  const s = await boot(
    {},
    {
      authorize: () => {
        throw new Error('db down')
      },
    },
  )
  try {
    assert.equal((await fetch(`${s.base}/events?topics=a`)).status, 500)
    const stats = s.hub.stats()
    assert.equal(stats.rejected['authorize-error'], 1)
    assert.equal(stats.rejected.unauthorized, 0, 'a broken authorizer is not a denial')
    assert.equal(stats.errors.authorize, 1)
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- gap signals

test('denied counts connections, not topics', async () => {
  const s = await boot({}, { authorize: (_req, topic) => topic === 'ok' })
  try {
    const c = await openStream(s.base, 'topics=ok,no1,no2')
    await c.waitFor((f) => f.includes('~denied'))

    // Two topics were refused on one connection. The interesting quantity is how many
    // clients were told they could not have something, not how long each list was.
    assert.equal(s.hub.stats().denied, 1)
    c.close()
  } finally {
    await s.close()
  }
})

test('truncated counts the clients actually told they lost events', async () => {
  // A ring too small to hold what follows, so the cursor below falls off it.
  const s = await boot({ maxHistoryBytes: 200 })
  try {
    await s.hub.publish('a', { n: 0 })
    const cursor = s.hub.cursor()
    for (let i = 1; i <= 40; i++) await s.hub.publish('a', { pad: 'x'.repeat(64), i })

    const c = await openStream(s.base, `topics=a&last_event_id=${encodeURIComponent(cursor)}`)
    await c.waitFor((f) => f.includes('history-truncated'))
    assert.equal(c.res.headers.get('last-event-id-checkpoint'), 'earliest')
    assert.equal(s.hub.stats().truncated, 1)

    // A reconnect from the live cursor missed nothing, so nothing is reported.
    const fresh = await openStream(
      s.base,
      `topics=a&last_event_id=${encodeURIComponent(s.hub.cursor())}`,
    )
    await fresh.waitFor((f) => f.startsWith(':ok'))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(s.hub.stats().truncated, 1, 'a clean resume is not a truncation')

    c.close()
    fresh.close()
  } finally {
    await s.close()
  }
})

test('replayed counts frames handed back on reconnect', async () => {
  const s = await boot()
  try {
    // Seed first, then take the cursor: `0-0` on a hub that has published nothing sorts
    // below the oldest retained entry, which §4.5 reads as a possible gap.
    await s.hub.publish('a', { n: 0 })
    const cursor = s.hub.cursor()
    await s.hub.publish('a', { n: 1 })
    await s.hub.publish('a', { n: 2 })
    await s.hub.publish('b', { n: 3 })

    const c = await openStream(s.base, `topics=a&last_event_id=${encodeURIComponent(cursor)}`)
    await c.waitFor((f) => f.includes('"n":2'))

    // Only the subscribed topic replays; `b` is not this connection's to receive.
    assert.equal(s.hub.stats().replayed, 2)
    assert.equal(s.hub.stats().truncated, 0)
    c.close()
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- slow consumers

test('a slow consumer is its own close reason', async () => {
  // Small enough that one publish past it trips §8.2, with no reader draining.
  const s = await boot({ maxBufferBytes: 512 })
  try {
    const res = await fetch(`${s.base}/events?topics=a`)
    await until(s.hub, (st) => st.connections === 1)

    // Never read the body: bytes queue on the socket instead.
    for (let i = 0; i < 200; i++) {
      await s.hub.publish('a', { pad: 'x'.repeat(2048), i })
      if (s.hub.stats().closed['slow-consumer'] > 0) break
    }

    const stats = await until(s.hub, (st) => st.closed['slow-consumer'] === 1)
    assert.equal(stats.connections, 0)
    assert.equal(stats.closed.client, 0, 'the drop was ours, not the client going away')
    await res.body.cancel().catch(() => {})
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- backplane

test('received and the opening gauge describe the backplane path', async () => {
  let deliver
  let releaseReplay
  const gate = new Promise((r) => {
    releaseReplay = r
  })

  const backplane = {
    publish: async (topic, payload, origin) => {
      const id = `${Date.now()}-0`
      deliver?.({ id, topic, payload, origin })
      return id
    },
    onEvent: (fn) => {
      deliver = fn
    },
    replay: async () => {
      await gate
      return { truncated: false, events: [] }
    },
    cursor: async () => '0-0',
    close: async () => {},
  }

  const s = await boot({ backplane })
  try {
    // A cursor is required to reach the replay path, which is where the window is.
    const pending = openStream(s.base, 'topics=a&last_event_id=1-0')

    // While replay is in flight the subscriber is registered but unanswered — the state
    // the backplane-window bugs all lived in, and the one gauge that makes it visible.
    const opening = await until(s.hub, (st) => st.opening === 1)
    assert.equal(opening.connections, 1)
    assert.equal(opening.opened, 1)

    releaseReplay()
    const c = await pending
    await c.waitFor((f) => f.startsWith(':ok'))
    await until(s.hub, (st) => st.opening === 0)

    await s.hub.publish('a', { n: 1 })
    await c.waitFor((f) => f.includes('"n":1'))

    const stats = s.hub.stats()
    // The event reaches subscribers by coming back round through the backplane, so it
    // is both published by this process and received by it.
    assert.equal(stats.published, 1)
    assert.equal(stats.received, 1)
    assert.equal(stats.delivered, 1)
    c.close()
  } finally {
    await s.close()
  }
})

test('a backplane replay that throws counts an error and forces a truncation', async () => {
  const backplane = {
    publish: async () => '1-0',
    onEvent: () => {},
    replay: async () => {
      throw new Error('redis down')
    },
    cursor: async () => '0-0',
    close: async () => {},
  }

  const s = await boot({ backplane })
  try {
    const c = await openStream(s.base, 'topics=a&last_event_id=1-0')
    await c.waitFor((f) => f.includes('history-truncated'))

    const stats = s.hub.stats()
    assert.equal(stats.errors.backplane, 1)
    // A backplane that cannot answer must never read as "nothing missed", and the
    // counter has to agree with what the client was actually told.
    assert.equal(stats.truncated, 1)
    c.close()
  } finally {
    await s.close()
  }
})
