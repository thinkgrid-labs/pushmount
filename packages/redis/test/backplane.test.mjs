// Redis backplane tests.
//
// Every test runs TWO hubs on TWO HTTP servers sharing one Redis stream — the same
// shape as two pods behind a load balancer. That is the only configuration where the
// interesting failures exist: a publish reaching a fraction of subscribers, two
// processes minting the same id, or a reconnect landing on the pod that has never seen
// the client before.
//
// Skips itself if Redis is not reachable, so `pnpm test` still works without it —
// which is the point: Redis is optional.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Redis from 'ioredis'
import { createHub } from '@pushmount/server'
import { createRedisBackplane } from '../dist/index.js'

const PORT = Number(process.env.REDIS_PORT ?? 6390)
const KEY = `pushmount:test:${process.pid}`

// Probed at module load, not in a `before` hook: node:test evaluates a test's `skip`
// option when the test is *defined*, which happens before any hook runs. Probing in
// `before` silently skips the whole file even when Redis is up.
const reachable = await (async () => {
  const probe = new Redis({ port: PORT, lazyConnect: true, retryStrategy: () => null })
  try {
    await probe.connect()
    await probe.ping()
    return true
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
})()

const options = () => ({ skip: reachable ? false : `no redis on :${PORT}` })

const clients = []
function client() {
  const c = new Redis({ port: PORT, maxRetriesPerRequest: null })
  clients.push(c)
  return c
}

after(async () => {
  if (reachable) {
    const c = new Redis({ port: PORT })
    const keys = await c.keys('pushmount:test:*')
    if (keys.length > 0) await c.del(...keys)
    c.disconnect()
  }
  for (const c of clients) c.disconnect()
})

/** One hub on its own HTTP server, sharing `key` with any other node in the test. */
async function node(key, hubOptions = {}, backplaneOptions = {}) {
  const backplane = await createRedisBackplane({
    redis: client(),
    subscriber: client(),
    key,
    blockMs: 100,
    ...backplaneOptions,
  })
  const hub = createHub({ keepAliveMs: 0, backplane, ...hubOptions })
  const handler = hub.handler()
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))

  return {
    hub,
    backplane,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      hub.close()
      await backplane.close()
      await new Promise((r) => server.close(r))
    },
  }
}

async function openStream(base, query) {
  const controller = new AbortController()
  const res = await fetch(`${base}/events?${query}`, { signal: controller.signal })
  const frames = []
  if (res.body) {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buffer = ''
    void (async () => {
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
        /* aborted */
      }
    })()
  }
  return {
    res,
    frames,
    data: () => frames.filter((f) => f.startsWith('id: ')),
    async waitFor(match, ms = 4000) {
      const deadline = Date.now() + ms
      for (;;) {
        const hit = frames.find(match)
        if (hit !== undefined) return hit
        if (Date.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    close: () => controller.abort(),
  }
}

const key = (suffix) => `${KEY}:${suffix}`

/** §2.1 — compare by parsed halves, never as strings. */
function byId(x, y) {
  const [xm, xs] = x.split('-').map(Number)
  const [ym, ys] = y.split('-').map(Number)
  if (xm !== ym) return xm < ym ? -1 : 1
  if (xs !== ys) return xs < ys ? -1 : 1
  return 0
}

test('a publish in one process reaches a subscriber in another', options(), async () => {
  const a = await node(key('fanout'))
  const b = await node(key('fanout'))
  try {
    const sub = await openStream(b.base, 'topics=t')
    await sub.waitFor((f) => f === ':ok\n\n')

    // Published on A. Without a backplane this is the silent failure the README warns
    // about: B's subscriber simply never hears about it, and nothing errors.
    const ack = await a.hub.publish('t', { from: 'process-a' })
    const frame = await sub.waitFor((f) => f.startsWith('id: '))

    assert.match(frame, /event: t\n/)
    assert.match(frame, /"from":"process-a"/)
    assert.ok(frame.startsWith(`id: ${ack.id}\n`), 'the id must be the one Redis assigned')
    sub.close()
  } finally {
    await a.close()
    await b.close()
  }
})

test('ids come from Redis, so two processes cannot collide', options(), async () => {
  const a = await node(key('ids'))
  const b = await node(key('ids'))
  try {
    // Interleaved publishes from both processes, in the same millisecond window.
    const acks = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).hub.publish('t', i)),
    )
    const ids = acks.map((x) => x.id)

    // The property that matters: no two processes ever mint the same id. A collision
    // would make one real event look already-seen to every client's dedupe.
    assert.equal(new Set(ids).size, ids.length, 'every id must be unique across processes')
    for (const id of ids) assert.match(id, /^\d+-\d+$/)

    // Deliberately NOT asserting that array order matches id order. These publishes race
    // on two connections, so the order calls return in reflects scheduling, not
    // assignment. Ordering in this protocol is defined by the id itself — which is the
    // whole point of a shared sequencer — so that is what gets checked.
    const sorted = [...ids].sort(byId)
    for (let i = 1; i < sorted.length; i++) {
      assert.equal(byId(sorted[i - 1], sorted[i]), -1, 'ids must be strictly increasing')
    }
  } finally {
    await a.close()
    await b.close()
  }
})

test('a client reconnecting to a different process still replays', options(), async () => {
  const a = await node(key('replay'))
  const b = await node(key('replay'))
  try {
    const first = await a.hub.publish('t', 'one')
    await a.hub.publish('t', 'two')
    await a.hub.publish('t', 'three')

    // The client last spoke to A; the load balancer sends it to B. B never saw the
    // first two events published before it started reading, so a local-history replay
    // would wrongly report a gap here.
    const sub = await openStream(b.base, `topics=t&last_event_id=${first.id}`)
    assert.equal(sub.res.headers.get('last-event-id-checkpoint'), first.id)

    await sub.waitFor((f) => f.includes('data: three'))
    const replayed = sub.data()
    assert.equal(replayed.length, 2, 'the cursor event itself is not replayed')
    assert.ok(replayed[0].includes('data: two'))
    sub.close()
  } finally {
    await a.close()
    await b.close()
  }
})

test('a cursor older than the shared history reports earliest', options(), async () => {
  const a = await node(key('trunc'), {})
  try {
    // Publish, then trim the stream so the cursor falls off the front.
    const first = await a.hub.publish('t', 'x')
    for (let i = 0; i < 5; i++) await a.hub.publish('t', 'y')
    const c = client()
    const entries = await c.xrange(key('trunc'), '-', '+')
    await c.xtrim(key('trunc'), 'MINID', entries[3][0])

    const sub = await openStream(a.base, `topics=t&last_event_id=${first.id}`)
    assert.equal(sub.res.headers.get('last-event-id-checkpoint'), 'earliest')
    const gap = await sub.waitFor((f) => f.startsWith('event: ~gap'))
    assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'history-truncated')
    sub.close()
  } finally {
    await a.close()
  }
})

test('a publisher’s own subscribers receive the event too', options(), async () => {
  // Everything goes through the backplane, including this process's own publishes, so
  // that every process sees one ordering. This checks the round trip actually closes.
  const a = await node(key('self'))
  try {
    const sub = await openStream(a.base, 'topics=t')
    await sub.waitFor((f) => f === ':ok\n\n')

    const ack = await a.hub.publish('t', 'local')
    const frame = await sub.waitFor((f) => f.startsWith('id: '))
    assert.ok(frame.startsWith(`id: ${ack.id}\n`))
    assert.equal(sub.data().length, 1, 'exactly once, not once locally and once via the stream')
    sub.close()
  } finally {
    await a.close()
  }
})

test('the cursor endpoint reflects the shared sequence', options(), async () => {
  const a = await node(key('cursor'))
  const b = await node(key('cursor'))
  try {
    const ack = await b.hub.publish('t', 'v')
    // A did not publish it, but must still report it: the cursor is global.
    const deadline = Date.now() + 3000
    let seen = ''
    while (Date.now() < deadline) {
      seen = await a.backplane.cursor()
      if (seen === ack.id) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(seen, ack.id)
  } finally {
    await a.close()
    await b.close()
  }
})

test('topics are filtered across the backplane, not just locally', options(), async () => {
  const a = await node(key('filter'))
  const b = await node(key('filter'))
  try {
    const sub = await openStream(b.base, `topics=${encodeURIComponent('org/1/orders')}`)
    await sub.waitFor((f) => f === ':ok\n\n')

    await a.hub.publish('org/2/orders', { secret: 'other-tenant' })
    await a.hub.publish('org/1/orders', { ok: true })

    await sub.waitFor((f) => f.includes('"ok":true'))
    assert.equal(sub.data().length, 1)
    assert.ok(!sub.frames.join('').includes('other-tenant'))
    sub.close()
  } finally {
    await a.close()
    await b.close()
  }
})

test('a cursor further behind than maxReplay is a gap, not an unbounded read', options(), async () => {
  // The cap is client-facing: `last_event_id` is whatever the request says it is, so
  // without a bound one request reads the whole retained stream and writes it to one
  // socket. Three is an absurd cap, chosen so the test states the rule rather than
  // measuring a machine.
  const a = await node(key('cap'), {}, { maxReplay: 3 })
  try {
    const first = await a.hub.publish('t', 0)
    for (let i = 1; i <= 6; i++) await a.hub.publish('t', i)

    const sub = await openStream(a.base, `topics=t&last_event_id=${encodeURIComponent(first.id)}`)

    // Six events behind a cap of three: the honest answer is "you missed things", the
    // dishonest one is a partial replay that leaves a hole the client cannot see.
    assert.equal(sub.res.headers.get('last-event-id-checkpoint'), 'earliest')
    await sub.waitFor((f) => f.includes('~gap'))
    assert.equal(sub.data().length, 0, 'a capped replay must serve no events at all')

    // And the stream is live afterwards — a gap costs the backlog, not the connection.
    const ack = await a.hub.publish('t', 'after')
    const frame = await sub.waitFor((f) => f.startsWith(`id: ${ack.id}\n`))
    // A string payload goes on the wire as-is; only non-strings are JSON-encoded.
    assert.match(frame, /\ndata: after\n/)
    sub.close()
  } finally {
    await a.close()
  }
})

test('a cursor within maxReplay still replays in full', options(), async () => {
  const a = await node(key('cap-ok'), {}, { maxReplay: 3 })
  try {
    const first = await a.hub.publish('t', 0)
    for (let i = 1; i <= 3; i++) await a.hub.publish('t', i)

    const sub = await openStream(a.base, `topics=t&last_event_id=${encodeURIComponent(first.id)}`)
    assert.equal(sub.res.headers.get('last-event-id-checkpoint'), first.id)
    await sub.waitFor((f) => f.includes('\ndata: 3\n'))
    assert.equal(sub.data().length, 3)
    assert.ok(!sub.frames.join('').includes('~gap'))
    sub.close()
  } finally {
    await a.close()
  }
})

test('an origin survives the backplane, so the right tab skips on every pod', options(), async () => {
  // §6.0 across processes. The tab that issued the write may be streaming from a
  // different pod than the one its POST landed on; an origin that only survived locally
  // would dedupe on one and duplicate on all the others.
  const a = await node(key('origin'))
  const b = await node(key('origin'))
  try {
    const sub = await openStream(b.base, 'topics=t')
    await sub.waitFor((f) => f === ':ok\n\n')

    await a.hub.publish('t', 'from-tab-a', { origin: 'tab-a' })
    const frame = await sub.waitFor((f) => f.startsWith('id: '))
    assert.match(frame, /\norigin: tab-a\n/)
    // Field order is normative: id, event, origin, data.
    assert.match(frame, /^id: [^\n]+\nevent: t\norigin: tab-a\ndata: from-tab-a\n\n$/)
    sub.close()
  } finally {
    await a.close()
    await b.close()
  }
})

test('a publish with no origin crosses the backplane without one', options(), async () => {
  const a = await node(key('origin-absent'))
  try {
    const sub = await openStream(a.base, 'topics=t')
    await sub.waitFor((f) => f === ':ok\n\n')

    await a.hub.publish('t', 'plain')
    const frame = await sub.waitFor((f) => f.startsWith('id: '))
    assert.ok(!frame.includes('origin:'), `origin leaked into: ${JSON.stringify(frame)}`)
    sub.close()
  } finally {
    await a.close()
  }
})
