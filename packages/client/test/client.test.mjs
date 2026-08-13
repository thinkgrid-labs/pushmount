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
