// Client integration tests — PROTOCOL.md §9.
// Run against the real server package over a real socket. The interesting behaviour
// here is all about reconnection, and a mock transport cannot produce it honestly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '@pushmount/server'
import { createClient } from '../dist/index.js'

async function boot({ hubOptions = {}, authorize } = {}) {
  const hub = createHub({ keepAliveMs: 0, ...hubOptions })
  const handler = hub.handler(authorize === undefined ? {} : { authorize })
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] === '/events') return handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, r))
  return {
    hub,
    url: `http://127.0.0.1:${server.address().port}/events`,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

async function until(predicate, ms = 2000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await tick(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ------------------------------------------------------------------ §9.1 one connection

test('ten components subscribing in one pass open exactly one connection', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const received = []
    for (let i = 0; i < 10; i++) {
      client.subscribe(`topic/${i}`, (data) => received.push(data))
    }
    await until(() => client.state === 'open', 2000, 'open')
    assert.equal(client.connectionCount, 1, 'debounce must collapse the mount storm')

    await s.hub.publish('topic/7', 'v')
    await until(() => received.length === 1, 2000, 'delivery')
    assert.equal(client.connectionCount, 1)
  } finally {
    client.close()
    await s.close()
  }
})

test('the same topic set in a different order does not reconnect', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const off1 = client.subscribe('b', () => {})
    const off2 = client.subscribe('a', () => {})
    await until(() => client.state === 'open')
    assert.equal(client.connectionCount, 1)

    // Re-subscribing the same two topics, opposite order, is not a change.
    off1(); off2()
    client.subscribe('a', () => {})
    client.subscribe('b', () => {})
    await tick(120)
    assert.equal(client.connectionCount, 1, 'topic set is compared as a sorted set')
  } finally {
    client.close()
    await s.close()
  }
})

test('adding a topic reconnects once and resumes from the cursor', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const seen = []
    client.subscribe('a', (d) => seen.push(['a', d]))
    await until(() => client.state === 'open')

    await s.hub.publish('a', 'one')
    await until(() => seen.length === 1)
    const cursorBefore = client.cursor
    assert.ok(cursorBefore, 'cursor should be tracked')

    // §9.3 — no client-to-server channel exists, so a new topic means a reconnect.
    client.subscribe('b', (d) => seen.push(['b', d]))
    await until(() => client.connectionCount === 2, 2000, 'second connection')

    await s.hub.publish('b', 'two')
    await until(() => seen.length === 2)
    assert.deepEqual(seen, [['a', 'one'], ['b', 'two']])
    // The reconnect carried the cursor, so 'one' was not redelivered.
    assert.equal(seen.filter(([, d]) => d === 'one').length, 1)
  } finally {
    client.close()
    await s.close()
  }
})

test('unsubscribing the last topic goes idle and closes the connection', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const off = client.subscribe('a', () => {})
    await until(() => client.state === 'open')
    assert.equal(s.hub.connectionCount(), 1)

    off()
    await until(() => client.state === 'idle', 2000, 'idle')
    await until(() => s.hub.connectionCount() === 0, 2000, 'server-side teardown')
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------------------ §9.2 cursor/dedupe

test('replayed events are not delivered twice', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const seen = []
    client.subscribe('a', (d) => seen.push(d))
    await until(() => client.state === 'open')

    await s.hub.publish('a', 'one')
    await s.hub.publish('a', 'two')
    await until(() => seen.length === 2)

    // Force a reconnect. The server registers the subscriber before snapshotting
    // history (§4.5), so replay can repeat an event the client already has.
    s.hub.disconnect(() => true)
    await until(() => client.connectionCount === 2, 3000, 'reconnect')

    await s.hub.publish('a', 'three')
    await until(() => seen.length === 3, 3000, 'third event')
    await tick(120)
    assert.deepEqual(seen, ['one', 'two', 'three'], 'no duplicates after replay')
  } finally {
    client.close()
    await s.close()
  }
})

test('initialCursor closes the cold-start window', async () => {
  const s = await boot()
  try {
    // The server-rendered page read its data, and the cursor, at this point.
    const cursorAtRender = s.hub.cursor()

    // Something is published before the browser gets around to opening the stream.
    await s.hub.publish('a', 'published-during-hydration')

    const seen = []
    const client = createClient({ url: s.url, debounceMs: 20, initialCursor: cursorAtRender })
    client.subscribe('a', (d) => seen.push(d))

    // Without initialCursor this event is lost forever, with nothing reported.
    await until(() => seen.length === 1, 2000, 'the event published during the window')
    assert.deepEqual(seen, ['published-during-hydration'])
    client.close()
  } finally {
    await s.close()
  }
})

// ----------------------------------------------------------------------- §8 gaps

test('onGap fires once for history-truncated, though it is signalled twice', async () => {
  const s = await boot({ hubOptions: { maxHistoryBytes: 400 } })
  try {
    const first = await s.hub.publish('a', 'x'.repeat(120))
    for (let i = 0; i < 20; i++) await s.hub.publish('a', 'x'.repeat(120))

    const gaps = []
    const client = createClient({
      url: s.url,
      debounceMs: 20,
      initialCursor: first.id,
      onGap: (reason, topics) => gaps.push({ reason, topics }),
    })
    client.subscribe('a', () => {})

    await until(() => gaps.length > 0, 2000, 'gap')
    await tick(150)
    // §8.1 sends the checkpoint header AND a ~gap frame on purpose. The application
    // must be told once.
    assert.equal(gaps.length, 1, `fired ${gaps.length} times: ${JSON.stringify(gaps)}`)
    assert.equal(gaps[0].reason, 'history-truncated')
    client.close()
  } finally {
    await s.close()
  }
})

test('a ~gap slow-consumer frame surfaces through onGap', async () => {
  // Driven by a stub server that emits the frame directly, rather than by creating
  // real backpressure.
  //
  // Producing genuine backpressure needs the client and server to share one event
  // loop and depends on kernel buffer sizes and scheduling; it passes in isolation
  // and is timing-dependent inside a suite. Worse, §8.2 makes the frame best-effort,
  // so a test built on real backpressure would be asserting something the protocol
  // explicitly declines to promise.
  //
  // The split is: the server package proves it *drops* a subscriber past
  // maxBufferBytes (slow-consumer.test.mjs, raw non-reading socket, deterministic).
  // This proves the client *reports* the frame when it arrives. Those are the two
  // separate responsibilities.
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    })
    res.write(':ok\n\n')
    res.write('event: ~gap\ndata: {"reason":"slow-consumer","topics":["a"]}\n\n')
    // The server closes right after, exactly as §8.2 requires.
    res.end()
  })
  await new Promise((r) => server.listen(0, r))
  const url = `http://127.0.0.1:${server.address().port}/events`

  const gaps = []
  const client = createClient({
    url,
    debounceMs: 20,
    baseBackoffMs: 50_000, // do not let the reconnect race the assertion
    onGap: (reason, topics) => gaps.push({ reason, topics }),
  })
  try {
    client.subscribe('a', () => {})
    await until(() => gaps.length > 0, 2000, 'gap')
    assert.equal(gaps[0].reason, 'slow-consumer')
    assert.deepEqual(gaps[0].topics, ['a'])
  } finally {
    client.close()
    await new Promise((r) => server.close(r))
  }
})

test('onDenied reports refused topics while the rest of the stream keeps working', async () => {
  const s = await boot({ authorize: (_req, topic) => topic.startsWith('ok/') })
  const denied = []
  const client = createClient({ url: s.url, debounceMs: 20, onDenied: (t) => denied.push(...t) })
  try {
    const seen = []
    client.subscribe('ok/a', (d) => seen.push(d))
    client.subscribe('nope/b', () => seen.push('LEAK'))

    await until(() => denied.length > 0, 2000, 'denied')
    assert.deepEqual(denied, ['nope/b'])
    assert.equal(client.state, 'open', 'one denied topic must not close the connection')

    await s.hub.publish('ok/a', 'still-works')
    await until(() => seen.length === 1)
    assert.deepEqual(seen, ['still-works'])
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------------------ §9.4 backoff

test('a 403 is fatal — the client does not retry a decision that cannot change', async () => {
  const s = await boot({ authorize: () => false })
  const errors = []
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    baseBackoffMs: 20,
    onError: (e) => errors.push(e),
  })
  try {
    client.subscribe('anything', () => {})
    await until(() => client.state === 'closed', 2000, 'closed')
    assert.equal(errors.length, 1)
    assert.match(String(errors[0].message), /403/)

    const after = client.connectionCount
    await tick(200)
    assert.equal(client.connectionCount, after, 'must not spin retrying a 403')
  } finally {
    client.close()
    await s.close()
  }
})

test('reconnects after the server drops the connection, and resumes', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20, baseBackoffMs: 30 })
  try {
    const seen = []
    client.subscribe('a', (d) => seen.push(d))
    await until(() => client.state === 'open')

    await s.hub.publish('a', 'before')
    await until(() => seen.length === 1)

    s.hub.disconnect(() => true)
    await until(() => client.connectionCount === 2, 3000, 'reconnect')
    await until(() => client.state === 'open', 2000, 'reopen')

    await s.hub.publish('a', 'after')
    await until(() => seen.length === 2, 2000, 'post-reconnect delivery')
    assert.deepEqual(seen, ['before', 'after'])
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------------------- robustness

test('a throwing handler is reported but does not tear down the shared connection', async () => {
  const s = await boot()
  const errors = []
  const client = createClient({ url: s.url, debounceMs: 20, onError: (e) => errors.push(e) })
  try {
    const good = []
    client.subscribe('a', () => { throw new Error('component blew up') })
    client.subscribe('a', (d) => good.push(d))
    await until(() => client.state === 'open')

    await s.hub.publish('a', 'v')
    await until(() => good.length === 1, 2000, 'the well-behaved handler still ran')
    assert.equal(errors.length, 1)
    assert.equal(client.state, 'open', 'connection must survive one bad component')
    assert.equal(client.connectionCount, 1, 'and must not reconnect over it')
  } finally {
    client.close()
    await s.close()
  }
})

test('close() stops everything and does not reconnect', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20, baseBackoffMs: 20 })
  try {
    client.subscribe('a', () => {})
    await until(() => client.state === 'open')
    const opened = client.connectionCount

    client.close()
    assert.equal(client.state, 'closed')
    await until(() => s.hub.connectionCount() === 0, 2000, 'server teardown')
    await tick(200)
    assert.equal(client.connectionCount, opened, 'no reconnect after close')
  } finally {
    await s.close()
  }
})

test('events are routed only to handlers of their own topic', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const a = []
    const b = []
    client.subscribe('a', (d) => a.push(d))
    client.subscribe('b', (d) => b.push(d))
    await until(() => client.state === 'open')

    await s.hub.publish('a', '1')
    await s.hub.publish('b', '2')
    await until(() => a.length === 1 && b.length === 1)
    assert.deepEqual(a, ['1'])
    assert.deepEqual(b, ['2'])
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------- listener registration

test('a gap listener fires alongside the constructor callback, not instead of it', async () => {
  const s = await boot({ hubOptions: { maxHistoryBytes: 400 } })
  try {
    const first = await s.hub.publish('a', 'x'.repeat(120))
    for (let i = 0; i < 20; i++) await s.hub.publish('a', 'x'.repeat(120))

    const fromOption = []
    const fromListener = []
    const client = createClient({
      url: s.url,
      debounceMs: 20,
      initialCursor: first.id,
      onGap: (reason) => fromOption.push(reason),
    })
    const unlisten = client.onGap((reason, topics) => fromListener.push({ reason, topics }))
    client.subscribe('a', () => {})

    await until(() => fromListener.length > 0, 2000, 'gap listener')
    // The application's own callback must keep working: an adapter registering here
    // cannot be allowed to take the signal away from the banner the app renders.
    assert.deepEqual(fromOption, ['history-truncated'])
    assert.equal(fromListener.length, 1)
    assert.deepEqual(fromListener[0], { reason: 'history-truncated', topics: ['a'] })

    unlisten()
    client.close()
  } finally {
    await s.close()
  }
})

test('a state listener sees the transitions, and stops when unsubscribed', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const seen = []
    const unlisten = client.onStateChange((state) => seen.push(state))
    client.subscribe('a', () => {})

    await until(() => client.state === 'open', 2000, 'open')
    assert.deepEqual(seen, ['connecting', 'open'])

    unlisten()
    client.close()
    // `closed` was emitted after the listener left, so it must not appear.
    assert.deepEqual(seen, ['connecting', 'open'])
  } finally {
    client.close()
    await s.close()
  }
})

test('a throwing listener does not stop the others or the connection', async () => {
  const s = await boot()
  const client = createClient({
    url: s.url,
    debounceMs: 20,
    onError: () => {},
  })
  try {
    const seen = []
    client.onStateChange(() => {
      throw new Error('listener is broken')
    })
    client.onStateChange((state) => seen.push(state))
    client.subscribe('a', () => {})

    await until(() => client.state === 'open', 2000, 'open')
    assert.deepEqual(seen, ['connecting', 'open'])

    // Deliberately the topic already subscribed to: adding a *new* one changes the
    // topic set, which reconnects, and a publish issued during that window is the
    // cold-start loss §5 describes rather than anything to do with listeners.
    const got = []
    client.subscribe('a', (data) => got.push(data))
    await s.hub.publish('a', 'still working')
    await until(() => got.length === 1, 2000, 'delivery')
  } finally {
    client.close()
    await s.close()
  }
})

// ------------------------------------------------------------------ reconnect()

test('a 403 stops the client, and reconnect() is what revives it', async () => {
  let permitted = false
  const s = await boot({ authorize: () => permitted })
  const client = createClient({ url: s.url, debounceMs: 20, onError: () => {} })
  try {
    const got = []
    client.subscribe('a', (data) => got.push(data))

    // Denied: not transient, so the client stops rather than backing off against a
    // decision that will not change on its own.
    await until(() => client.rejected, 2000, 'rejection')
    assert.equal(client.state, 'closed')
    const attempts = client.connectionCount

    await tick(200)
    assert.equal(client.connectionCount, attempts, 'a stopped client must not retry')

    // The application logs back in and says so.
    permitted = true
    client.reconnect()

    await until(() => client.state === 'open', 3000, 'reopen')
    assert.equal(client.rejected, false)
    await s.hub.publish('a', 'after re-auth')
    await until(() => got.length === 1, 2000, 'delivery')
  } finally {
    client.close()
    await s.close()
  }
})

test('reconnect() resumes from the cursor rather than restarting', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    const got = []
    client.subscribe('a', (data) => got.push(data))
    await until(() => client.state === 'open', 2000, 'open')

    await s.hub.publish('a', 'one')
    await until(() => got.length === 1, 2000, 'first')
    const cursor = client.cursor

    client.reconnect()
    await until(() => client.state === 'open', 3000, 'reopen')

    // Same cursor, so history is replayed from where it left off — and §9.2 dedupe
    // means the event already delivered is not delivered twice.
    assert.equal(client.cursor, cursor)
    await tick(150)
    assert.equal(got.length, 1, `redelivered: ${JSON.stringify(got)}`)

    await s.hub.publish('a', 'two')
    await until(() => got.length === 2, 2000, 'second')
  } finally {
    client.close()
    await s.close()
  }
})

test('reconnect() on a closed client stays closed', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20 })
  try {
    client.subscribe('a', () => {})
    await until(() => client.state === 'open', 2000, 'open')

    client.close()
    client.reconnect()
    await tick(150)

    // close() is an end of life, not a failure to recover from.
    assert.equal(client.state, 'closed')
    await until(() => s.hub.connectionCount() === 0, 2000, 'server saw the close')
  } finally {
    client.close()
    await s.close()
  }
})

test('a revoked connection reconnects, is refused, and recovers on reconnect()', async () => {
  // The whole story end to end: authorization is inherited once at connect, the server
  // notices it has expired, and the client finds out the only way it can — by being
  // turned away when it tries to resume.
  let permitted = true
  const hub = createHub({ keepAliveMs: 0 })
  const handler = hub.handler({ authorize: () => permitted, revalidateMs: 40 })
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] === '/events') return void handler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, r))
  const url = `http://127.0.0.1:${server.address().port}/events`

  const client = createClient({ url, debounceMs: 20, baseBackoffMs: 30, onError: () => {} })
  try {
    const got = []
    client.subscribe('a', (data) => got.push(data))
    await until(() => client.state === 'open', 2000, 'open')

    permitted = false
    // Revalidation closes the stream; the client reconnects on its own and *that*
    // request is the one that gets the 403.
    await until(() => client.rejected, 3000, 'rejection after revocation')
    assert.equal(hub.connectionCount(), 0)

    permitted = true
    client.reconnect()
    await until(() => client.state === 'open', 3000, 'reopen')

    await hub.publish('a', 'welcome back')
    await until(() => got.length === 1, 2000, 'delivery')
  } finally {
    client.close()
    hub.close()
    await new Promise((r) => server.close(r))
  }
})

// ------------------------------------------------------------------- §6.0 origin

test('a client skips the events it caused, and other clients still get them', async () => {
  const s = await boot()
  const actor = createClient({ url: s.url, debounceMs: 20, originId: 'tab-a' })
  const observer = createClient({ url: s.url, debounceMs: 20, originId: 'tab-b' })
  try {
    const mine = []
    const theirs = []
    actor.subscribe('orders', (d) => mine.push(d))
    observer.subscribe('orders', (d) => theirs.push(d))
    await until(() => actor.state === 'open' && observer.state === 'open', 2000, 'both open')

    // The write came from tab A, so the server echoes A's origin on the event.
    await s.hub.publish('orders', 'created-by-a', { origin: 'tab-a' })

    await until(() => theirs.length === 1, 2000, 'observer delivery')
    await tick(150)
    assert.deepEqual(theirs, ['created-by-a'])
    // A already applied this from its own POST response; a second copy is the
    // double-render that reads as an application bug.
    assert.deepEqual(mine, [], 'the originating client must not receive its own echo')
  } finally {
    actor.close()
    observer.close()
    await s.close()
  }
})

test('a skipped event still advances the cursor', async () => {
  const s = await boot()
  const client = createClient({ url: s.url, debounceMs: 20, originId: 'tab-a' })
  try {
    const got = []
    client.subscribe('orders', (d) => got.push(d))
    await until(() => client.state === 'open', 2000, 'open')

    const ack = await s.hub.publish('orders', 'mine', { origin: 'tab-a' })
    await until(() => client.cursor === ack.id, 2000, 'cursor advanced')
    assert.deepEqual(got, [])

    // Without the cursor advancing, this reconnect would replay the skipped event —
    // and every one before it — for as long as the tab kept writing.
    client.reconnect()
    await until(() => client.state === 'open', 3000, 'reopen')
    await tick(150)
    assert.deepEqual(got, [], 'a skipped event must not come back on reconnect')

    await s.hub.publish('orders', 'someone else')
    await until(() => got.length === 1, 2000, 'delivery')
    assert.deepEqual(got, ['someone else'])
  } finally {
    client.close()
    await s.close()
  }
})

test('an origin id is generated when none is supplied', async () => {
  const s = await boot()
  const a = createClient({ url: s.url, debounceMs: 20 })
  const b = createClient({ url: s.url, debounceMs: 20 })
  try {
    // The feature has to cost nothing to adopt: read it and attach it to writes.
    assert.ok(a.originId.length > 0)
    assert.notEqual(a.originId, b.originId)
  } finally {
    a.close()
    b.close()
    await s.close()
  }
})

test('an origin that would forge a frame is refused, not sanitised', async () => {
  const s = await boot()
  try {
    // §6.0 — the whole reason the field is validated: an LF ends the frame, and what
    // follows parses as the next one.
    await assert.rejects(
      () => s.hub.publish('orders', 'v', { origin: 'a\nid: 9-9\nevent: ~gap\ndata: {}' }),
      /invalid origin/,
    )
    await assert.rejects(() => s.hub.publish('orders', 'v', { origin: 'x'.repeat(65) }), /invalid origin/)

    // An empty origin is absent, not an error — `?? ''` is how JavaScript spells a
    // missing header.
    const ack = await s.hub.publish('orders', 'v', { origin: '' })
    assert.match(ack.id, /^\d+-\d+$/)
  } finally {
    await s.close()
  }
})
