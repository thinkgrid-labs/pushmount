// HTTP handler tests — PROTOCOL.md §4, §5, §7, §8.
// Runs against a real node:http server over a real socket; nothing here is mocked,
// because every requirement in §4.4 exists to survive something a mock cannot model.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '../dist/index.js'

/** Boots a server whose routes mirror the quickstart. */
async function boot(hubOptions = {}, handlerOptions = {}, decorate = () => {}) {
  const hub = createHub({ keepAliveMs: 0, ...hubOptions })
  const handler = hub.handler(handlerOptions)
  const cursorHandler = hub.cursorHandler()

  const server = createServer((req, res) => {
    decorate(req)
    const path = req.url.split('?')[0]
    if (path === '/events/cursor') return cursorHandler(req, res)
    if (path === '/events') return handler(req, res)
    res.writeHead(404).end()
  })

  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    hub,
    base,
    async close() {
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

/** Opens a stream and collects frames until `count` non-comment frames arrive. */
async function openStream(base, query, init = {}) {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/events?${query}`, { ...init, signal: ctrl.signal })
  const frames = []
  let buffer = ''
  let reader

  if (res.body) {
    reader = res.body.getReader()
    const dec = new TextDecoder()
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
    /** Waits for a frame matching `match`, or throws after `ms`. */
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

const dataFrames = (frames) => frames.filter((f) => f.startsWith('id: '))

// ---------------------------------------------------------------- §4.1 / §4.2

test('400 when topics is missing or empty', async () => {
  const s = await boot()
  try {
    assert.equal((await fetch(`${s.base}/events`)).status, 400)
    assert.equal((await fetch(`${s.base}/events?topics=`)).status, 400)
  } finally {
    await s.close()
  }
})

test('400 for a topic that violates §3', async () => {
  const s = await boot()
  try {
    for (const bad of ['%7Egap', 'a%0Ab', 'a%00b', encodeURIComponent('x'.repeat(256))]) {
      const res = await fetch(`${s.base}/events?topics=${bad}`)
      assert.equal(res.status, 400, `topic ${bad} should be rejected`)
    }
  } finally {
    await s.close()
  }
})

test('400 for a malformed cursor rather than silently starting live', async () => {
  const s = await boot()
  try {
    // The dangerous alternative: treat it as "no cursor", open the stream, and let the
    // client believe it resumed. It would never be told otherwise.
    const res = await fetch(`${s.base}/events?topics=t&last_event_id=nonsense`)
    assert.equal(res.status, 400)
    const res2 = await fetch(`${s.base}/events?topics=t`, {
      headers: { 'last-event-id': '01-0' },
    })
    assert.equal(res2.status, 400, 'leading zeros are not canonical')

    // The same rule one step earlier, at the decode. `topics` and `last_event_id` are
    // decoded by the same call, but a failure means different things: a `topics` decode
    // that fails leaves nothing to subscribe to, while a cursor decode that fails leaves
    // a request that still works — so the tempting shape, decode-or-null, quietly opens a
    // live-only stream. The client sent a cursor, gets no checkpoint header back because
    // the server believes there was none, and cannot tell that it was dropped.
    const res3 = await fetch(`${s.base}/events?topics=t&last_event_id=%ZZ`)
    assert.equal(res3.status, 400, 'malformed percent-encoding is not "no cursor"')

    // Well-formed escapes spelling an incomplete UTF-8 sequence: the same throw, without
    // the tell that a hand-rolled `%XX` check would catch.
    const res4 = await fetch(`${s.base}/events?topics=t&last_event_id=%E0%A4%A`)
    assert.equal(res4.status, 400, 'a truncated UTF-8 sequence is malformed too')

    // And an absent cursor is still absent — the parameter left empty carries no id to
    // lose, so it opens a live stream rather than becoming a 400.
    const live = new AbortController()
    const res5 = await fetch(`${s.base}/events?topics=t&last_event_id=`, { signal: live.signal })
    assert.equal(res5.status, 200)
    live.abort()
  } finally {
    await s.close()
  }
})

test('a topic containing a comma survives percent-encoding', async () => {
  // URLSearchParams decodes on access, which would split "a%2Cb" into two topics.
  const s = await boot()
  try {
    const stream = await openStream(s.base, `topics=${encodeURIComponent('a,b')}`)
    await stream.waitFor((f) => f === ':ok\n\n')
    await s.hub.publish('a,b', 'yes')
    const frame = await stream.waitFor((f) => f.startsWith('id: '))
    assert.match(frame, /event: a,b\n/)
    stream.close()
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------------------ §4.3 authz

test('403 only when every requested topic is denied', async () => {
  const s = await boot({}, { authorize: (_req, topic) => topic.startsWith('org/42/') })
  try {
    const denied = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/99/a')}`)
    assert.equal(denied.status, 403)

    const ok = await fetch(`${s.base}/events?topics=${encodeURIComponent('org/42/a')}`)
    assert.equal(ok.status, 200)
    await ok.body.cancel()
  } finally {
    await s.close()
  }
})

test('partial denial opens the stream and names the refused topics', async () => {
  const s = await boot({}, { authorize: (_req, topic) => topic.startsWith('org/42/') })
  try {
    const stream = await openStream(
      s.base,
      `topics=${encodeURIComponent('org/42/a')},${encodeURIComponent('org/99/b')}`,
    )
    assert.equal(stream.res.status, 200, 'one forbidden topic must not kill the connection')

    const frame = await stream.waitFor((f) => f.startsWith('event: ~denied'))
    assert.deepEqual(JSON.parse(frame.split('data: ')[1]).topics, ['org/99/b'])

    // The authorized topic still works.
    await s.hub.publish('org/42/a', 'v')
    await stream.waitFor((f) => f.startsWith('id: '))
    // The denied one is not delivered.
    await s.hub.publish('org/99/b', 'leak')
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(dataFrames(stream.frames).length, 1)
    stream.close()
  } finally {
    await s.close()
  }
})

test('cross-tenant isolation: a publish reaches only subscribers of that topic', async () => {
  const s = await boot()
  try {
    const a = await openStream(s.base, `topics=${encodeURIComponent('org/1/orders')}`)
    const b = await openStream(s.base, `topics=${encodeURIComponent('org/2/orders')}`)
    await a.waitFor((f) => f === ':ok\n\n')
    await b.waitFor((f) => f === ':ok\n\n')

    await s.hub.publish('org/1/orders', { secret: 'tenant-one' })
    await a.waitFor((f) => f.startsWith('id: '))
    await new Promise((r) => setTimeout(r, 60))

    assert.equal(dataFrames(b.frames).length, 0)
    assert.ok(!b.frames.join('').includes('tenant-one'))
    a.close(); b.close()
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------------------ §4.4 headers

test('sends the headers that make the stream survive a proxy', async () => {
  const s = await boot()
  try {
    const stream = await openStream(s.base, 'topics=t')
    const h = stream.res.headers
    assert.match(h.get('content-type'), /^text\/event-stream/)
    assert.equal(h.get('cache-control'), 'no-cache, no-transform')
    assert.equal(h.get('x-accel-buffering'), 'no')
    // No cursor was presented, so §4.4 says the checkpoint header must be absent.
    assert.equal(h.get('last-event-id-checkpoint'), null)
    stream.close()
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------- §4.5 replay + checkpoint

test('replays events newer than the cursor and echoes the checkpoint', async () => {
  const s = await boot()
  try {
    const first = await s.hub.publish('t', 'one')
    await s.hub.publish('t', 'two')
    await s.hub.publish('t', 'three')

    const stream = await openStream(s.base, `topics=t&last_event_id=${first.id}`)
    assert.equal(stream.res.headers.get('last-event-id-checkpoint'), first.id)

    await stream.waitFor((f) => f.includes('data: three'))
    const replayed = dataFrames(stream.frames)
    assert.equal(replayed.length, 2, 'the cursor event itself is not replayed')
    assert.ok(replayed[0].includes('data: two'))
    stream.close()
  } finally {
    await s.close()
  }
})

// The quickstart's own path: a page is rendered with `hub.cursor()` alongside its data,
// then opens the stream with it. On a hub that has just booted that cursor is `0-0`, and
// `0-0` sorts below every real id — so comparing it against the OLDEST RETAINED event
// reported a gap to a client that could not possibly have missed anything. Every first
// page load after a deploy refetched, and the one signal worth trusting cried wolf.
test('the cold-start cursor 0-0 replays without reporting a gap', async () => {
  const s = await boot()
  try {
    const cold = s.hub.cursor()
    assert.equal(cold, '0-0')
    await s.hub.publish('t', 'one')
    await s.hub.publish('t', 'two')

    const stream = await openStream(s.base, `topics=t&last_event_id=${cold}`)
    // Nothing was ever evicted, so the cursor is honoured rather than downgraded.
    assert.equal(stream.res.headers.get('last-event-id-checkpoint'), cold)
    await stream.waitFor((f) => f.includes('two'))
    assert.equal(dataFrames(stream.frames).length, 2, 'both events replay')
    assert.ok(
      !stream.frames.some((f) => f.startsWith('event: ~gap')),
      'a hub that has dropped nothing must not claim it has',
    )
    stream.close()
  } finally {
    await s.close()
  }
})

/**
 * A backplane that is already carrying a deployment's traffic when this process starts:
 * its sequence is at `at`, and nothing has come through the reader yet. `deliver` is the
 * reader, so a test can decide when this process learns anything.
 */
function runningBackplane(at) {
  let sink = () => {}
  let cursor = at
  return {
    publish: async (topic, payload, origin) => {
      cursor = `${Number(cursor.split('-')[0]) + 1}-0`
      sink({ id: cursor, topic, payload, origin })
      return cursor
    },
    onEvent: (next) => {
      sink = next
    },
    replay: async () => ({ truncated: false, events: [] }),
    cursor: async () => cursor,
    close: async () => {},
    deliver: (event) => sink(event),
    advance: (id) => {
      cursor = id
    },
  }
}

// §5 in a cluster. A worker that has just booted has an empty ring and has read nothing,
// so its own sequence is `0-0` — while the shared log it just joined holds everything the
// deployment published before it started. Stamping that on a page asks the stream for the
// entire retained history, and is answered with `~gap`: a refetch on every page a freshly
// started worker serves, which is every page for the length of a rolling deploy.
test('a worker joining a running deployment does not hand out a cold-start cursor', async () => {
  const backplane = runningBackplane('1755083412345-7')
  const s = await boot({ backplane })
  try {
    await s.hub.ready()
    assert.equal(s.hub.cursor(), '1755083412345-7', 'the sequence is shared, so the cursor is')
    assert.equal(await s.hub.sharedCursor(), '1755083412345-7')

    const res = await fetch(`${s.base}/events/cursor`)
    assert.deepEqual(await res.json(), { cursor: '1755083412345-7' })
  } finally {
    await s.close()
  }
})

test('the cursor tracks the shared sequence and never walks back', async () => {
  const backplane = runningBackplane('1000-0')
  const s = await boot({ backplane })
  try {
    await s.hub.ready()
    backplane.deliver({ id: '2000-0', topic: 't', payload: 'from another process' })
    assert.equal(s.hub.cursor(), '2000-0', 'an event read from the log advances it')

    // A backplane answering with something older — a replica behind the primary, a
    // reordered response — must not drag a cursor this process has already handed out
    // backwards. A cursor that moves back re-replays what the client already applied.
    backplane.advance('500-0')
    assert.equal(await s.hub.sharedCursor(), '2000-0')
  } finally {
    await s.close()
  }
})

test('a backplane that cannot answer at boot still serves, with a cursor merely behind', async () => {
  const errors = []
  const backplane = {
    ...runningBackplane('0-0'),
    cursor: async () => {
      throw new Error('redis unreachable')
    },
  }
  const s = await boot({ backplane, onError: (e) => errors.push(e) })
  try {
    // `ready` resolving is the load-bearing part: the stream handler awaits it, so a
    // rejection here would take out every request rather than one cursor.
    await s.hub.ready()
    assert.equal(s.hub.cursor(), '0-0')
    assert.equal(await s.hub.sharedCursor(), '0-0', 'falls back rather than failing the page')
    const res = await fetch(`${s.base}/events/cursor`)
    assert.equal(res.status, 200)
    assert.equal(errors.length > 0, true, 'and it is reported rather than swallowed')
  } finally {
    await s.close()
  }
})

// A core that fails on its own terms is not a bad request, and saying it is hides the
// fault twice over: the caller is told to fix a request that was fine, and the operator
// sees a rising `bad-request` count with nothing in `errors` and no `onError` call. The
// native seam used to classify by searching the message for substrings and calling
// anything unmatched an invalid topic, so every napi conversion failure, every panic
// unwound through the boundary and every version-skewed addon arrived as `400
// invalid-topic`.
test('a core failing on its own terms is a 500, reported, not a 400 blaming the caller', async () => {
  const errors = []
  // A `HubCore` that works until it does not — the shape of every failure that is the
  // server's rather than the request's.
  const failing = {
    publish: () => ({ id: '1-0', frame: new Uint8Array(), targets: [] }),
    append: () => ({ id: '1-0', frame: new Uint8Array(), targets: [] }),
    encode: () => new Uint8Array(),
    subscribe: () => {
      throw new Error('Failed to convert JS value into rust type `String`')
    },
    noteBuffer: () => 'ok',
    noteSent: () => 'ok',
    noteFlushed: () => 'ok',
    remove: () => true,
    cursor: () => '0-0',
    connectionCount: () => 0,
    slowConsumerFrame: () => new Uint8Array(),
    truncatedFrame: () => new Uint8Array(),
    deniedFrame: () => new Uint8Array(),
    compareIds: () => 0,
    validTopic: () => true,
    validOrigin: () => true,
  }
  const s = await boot({ core: failing, onError: (e) => errors.push(e) })
  try {
    const res = await fetch(`${s.base}/events?topics=t`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'core-error' })

    const stats = s.hub.stats()
    assert.equal(stats.errors.core, 1, 'the operator has to be able to see it')
    assert.equal(stats.rejected['core-error'], 1)
    assert.equal(stats.rejected['bad-request'], 0, 'the caller did nothing wrong')
    assert.equal(stats.rejected['authorize-error'], 0, 'and `authorize` was not involved')
    assert.equal(errors.length, 1, 'onError must see what nothing else would report')
    assert.match(errors[0].message, /convert JS value/, 'unwrapped, so the cause survives')
  } finally {
    await s.close()
  }
})

// The mirror image, and the more dangerous one. A frame bigger than the whole budget is
// evicted by the very push that added it, leaving the ring empty — and an empty ring has
// no oldest entry to compare against, so a real loss was reported as "nothing missed".
test('an event too large for the ring is still reported as a gap', async () => {
  const s = await boot({ maxHistoryBytes: 64 })
  try {
    const cold = s.hub.cursor()
    await s.hub.publish('t', 'x'.repeat(500))

    const stream = await openStream(s.base, `topics=t&last_event_id=${cold}`)
    assert.equal(stream.res.headers.get('last-event-id-checkpoint'), 'earliest')
    const gap = await stream.waitFor((f) => f.startsWith('event: ~gap'))
    assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'history-truncated')
    stream.close()
  } finally {
    await s.close()
  }
})

test('a cursor at the evicted id is not a gap — that event is the one the client holds', async () => {
  const s = await boot({ maxHistoryBytes: 400 })
  try {
    // Frames are ~157 bytes here, so a 400-byte ring holds two: the third publish
    // evicts `first` and only `first` — exactly the event the client already has.
    const first = await s.hub.publish('t', 'x'.repeat(120))
    for (let i = 0; i < 2; i++) await s.hub.publish('t', 'x'.repeat(120))

    const stream = await openStream(s.base, `topics=t&last_event_id=${first.id}`)
    assert.equal(stream.res.headers.get('last-event-id-checkpoint'), first.id)
    assert.ok(
      !stream.frames.some((f) => f.startsWith('event: ~gap')),
      'everything after the cursor is still retained',
    )
    stream.close()
  } finally {
    await s.close()
  }
})

test('reports earliest in the header AND a ~gap frame when history has moved on', async () => {
  const s = await boot({ maxHistoryBytes: 400 })
  try {
    const first = await s.hub.publish('t', 'x'.repeat(120))
    for (let i = 0; i < 20; i++) await s.hub.publish('t', 'x'.repeat(120))

    const stream = await openStream(s.base, `topics=t&last_event_id=${first.id}`)
    // §8.1 — signalled twice on purpose: the header is authoritative, the frame
    // survives a header-stripping proxy.
    assert.equal(stream.res.headers.get('last-event-id-checkpoint'), 'earliest')
    const gap = await stream.waitFor((f) => f.startsWith('event: ~gap'))
    assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'history-truncated')
    stream.close()
  } finally {
    await s.close()
  }
})

test('control frames carry no id, so they cannot advance a client cursor', async () => {
  const s = await boot({ maxHistoryBytes: 400 }, { authorize: (_r, t) => t !== 'nope' })
  try {
    const first = await s.hub.publish('t', 'x'.repeat(120))
    for (let i = 0; i < 20; i++) await s.hub.publish('t', 'x'.repeat(120))

    const stream = await openStream(s.base, `topics=t,nope&last_event_id=${first.id}`)
    const denied = await stream.waitFor((f) => f.startsWith('event: ~denied'))
    const gap = await stream.waitFor((f) => f.startsWith('event: ~gap'))
    assert.ok(!denied.includes('id: '))
    assert.ok(!gap.includes('id: '))
    stream.close()
  } finally {
    await s.close()
  }
})

// ------------------------------------------------------------- §5 cursor endpoint

test('the cursor endpoint reports 0-0 before anything is published, then advances', async () => {
  const s = await boot()
  try {
    let body = await (await fetch(`${s.base}/events/cursor`)).json()
    assert.equal(body.cursor, '0-0')

    const ack = await s.hub.publish('t', 'v')
    body = await (await fetch(`${s.base}/events/cursor`)).json()
    assert.equal(body.cursor, ack.id, 'this is what closes the cold-start window')
  } finally {
    await s.close()
  }
})

// -------------------------------------------------------- §10 caps and teardown

test('429 with Retry-After once the connection cap is reached', async () => {
  const s = await boot({ maxConnections: 1 })
  try {
    const first = await openStream(s.base, 'topics=t')
    await first.waitFor((f) => f === ':ok\n\n')

    const second = await fetch(`${s.base}/events?topics=t`)
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '5')
    await second.body.cancel()
    first.close()
  } finally {
    await s.close()
  }
})

test('disconnected clients are removed — 40 open/abort cycles leave nothing behind', async () => {
  const s = await boot()
  try {
    for (let i = 0; i < 40; i++) {
      const stream = await openStream(s.base, `topics=org/${i}/t`)
      await stream.waitFor((f) => f === ':ok\n\n')
      stream.close()
    }
    // Give the close events time to land.
    const deadline = Date.now() + 2000
    while (s.hub.connectionCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(s.hub.connectionCount(), 0, 'every tab that ever connected would leak')
  } finally {
    await s.close()
  }
})

test('disconnect(predicate) evicts a session whose authorization has been revoked', async () => {
  // §4.3 authorizes once, at connect. Without this escape hatch a revoked session
  // keeps receiving events until the tab closes.
  const s = await boot({}, {}, (req) => {
    req.userId = new URL(req.url, 'http://x').searchParams.get('u')
  })
  try {
    const a = await openStream(s.base, 'topics=t&u=alice')
    const b = await openStream(s.base, 'topics=t&u=bob')
    await a.waitFor((f) => f === ':ok\n\n')
    await b.waitFor((f) => f === ':ok\n\n')
    assert.equal(s.hub.connectionCount(), 2)

    const evicted = s.hub.disconnect((req) => req.userId === 'alice')
    assert.equal(evicted, 1)
    assert.equal(s.hub.connectionCount(), 1)

    await s.hub.publish('t', 'after-revocation')
    await b.waitFor((f) => f.startsWith('id: '))
    assert.equal(dataFrames(a.frames).length, 0, 'evicted session must receive nothing')
    a.close(); b.close()
  } finally {
    await s.close()
  }
})

test('publish reports how many subscribers it reached', async () => {
  const s = await boot()
  try {
    assert.equal((await s.hub.publish('t', 'v')).delivered, 0)
    const stream = await openStream(s.base, 'topics=t')
    await stream.waitFor((f) => f === ':ok\n\n')
    assert.equal((await s.hub.publish('t', 'v')).delivered, 1)
    stream.close()
  } finally {
    await s.close()
  }
})

test('non-string payloads are JSON-serialised; strings pass through raw', async () => {
  const s = await boot()
  try {
    const stream = await openStream(s.base, 'topics=t')
    await stream.waitFor((f) => f === ':ok\n\n')

    await s.hub.publish('t', { total: 4200 })
    const obj = await stream.waitFor((f) => f.includes('total'))
    assert.ok(obj.includes('data: {"total":4200}'))

    await s.hub.publish('t', 'plain\nstring')
    const str = await stream.waitFor((f) => f.includes('plain'))
    // §6.1 — segmented, not raw, so the newline cannot terminate the frame.
    assert.ok(str.includes('data: plain\ndata: string\n'))
    assert.equal(str.split('\n\n').length, 2)
    stream.close()
  } finally {
    await s.close()
  }
})
