// Vue composable tests.
//
// Against a real hub over a real socket, like the rest of this repo's binding tests: the
// point of a binding is what it does with a live connection, and a mocked client would
// only prove the wrapper calls itself.
//
// No jsdom. `@aghoz/client` is built on fetch and streams and touches no DOM, and Vue's
// reactivity runs standalone in an `effectScope` — so these run in bare Node.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApp, effectScope, nextTick, ref } from 'vue'
import { createHub } from '@aghoz/server'
import { createClient } from '@aghoz/client'
import {
  AGHOZ_KEY,
  provideAghoz,
  useAghoz,
  useConnectionState,
  useTopic,
  useTopicEffect,
  useTopicReducer,
} from '../dist/index.js'

async function boot() {
  const hub = createHub({ keepAliveMs: 0 })
  const handler = hub.handler()
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/events') return res.writeHead(404).end()
    handler(req, res)
  })
  await new Promise((r) => server.listen(0, r))

  const clients = []
  return {
    hub,
    url: `http://127.0.0.1:${server.address().port}/events`,
    track(client) {
      clients.push(client)
      return client
    },
    async close() {
      for (const c of clients) c.close()
      hub.close()
      await new Promise((r) => server.close(r))
    },
  }
}

/**
 * Waits until the shared stream is really open.
 *
 * Publishing before it is open loses the event with nothing reported — that is the
 * cold-start window §5 exists for, and in a test it just looks like a broken binding.
 */
async function opened(client, ms = 4000) {
  const deadline = Date.now() + ms
  while (client.state !== 'open') {
    if (Date.now() > deadline) throw new Error(`stream never opened; state=${client.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Waits for `read()` to satisfy `predicate`, or throws. */
async function until(read, predicate, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    await nextTick()
    const value = read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out at ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------- values

test('useTopic holds the most recent value', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const value = scope.run(() => useTopic('orders', null, { client }))

    assert.equal(value.value, null, 'starts at the initial value')
    await opened(client)

    await s.hub.publish('orders', { id: 'ord_1' })
    await until(() => value.value, (v) => v?.id === 'ord_1')

    await s.hub.publish('orders', { id: 'ord_2' })
    // A last-value cell: the second event replaces the first rather than accumulating.
    await until(() => value.value, (v) => v?.id === 'ord_2')
  } finally {
    scope.stop()
    await s.close()
  }
})

test('useTopic uses a shallow ref, so payload identity survives', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const seen = []
    const value = scope.run(() =>
      useTopic('t', null, {
        client,
        // A parse that returns a known object. A deep ref would hand back a reactive
        // proxy instead, so `===` against the parsed object would fail and any identity
        // check downstream would silently stop working.
        parse: (raw) => {
          const parsed = { raw }
          seen.push(parsed)
          return parsed
        },
      }),
    )

    await opened(client)
    await s.hub.publish('t', { n: 1 })
    await until(() => value.value, (v) => v !== null)
    assert.equal(value.value, seen[0], 'the ref holds the object itself, not a proxy of it')
  } finally {
    scope.stop()
    await s.close()
  }
})

test('parse defaults to JSON.parse and can be replaced', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const raw = scope.run(() => useTopic('t', '', { client, parse: (s) => s }))

    // Published as a bare string that is not valid JSON — the case the default would
    // throw on, which is why the default is not a guess-and-fall-back.
    await opened(client)
    await s.hub.publish('t', 'not json')
    await until(() => raw.value, (v) => v === 'not json')
  } finally {
    scope.stop()
    await s.close()
  }
})

test('useTopicReducer folds events into a collection', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const list = scope.run(() =>
      useTopicReducer('orders', (state, value) => [...state, value.id], [], { client }),
    )

    await opened(client)
    await s.hub.publish('orders', { id: 'a' })
    await s.hub.publish('orders', { id: 'b' })
    await until(() => list.value, (v) => v.length === 2)
    assert.deepEqual(list.value, ['a', 'b'])
  } finally {
    scope.stop()
    await s.close()
  }
})

test('useTopicEffect runs without holding state, and receives event metadata', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const calls = []
    scope.run(() => useTopicEffect('t', (value, meta) => calls.push({ value, meta }), { client }))

    await opened(client)
    await s.hub.publish('t', { n: 1 })
    await until(() => calls, (c) => c.length === 1)
    assert.deepEqual(calls[0].value, { n: 1 })
    assert.match(calls[0].meta.id, /^\d+-\d+$/)
    assert.equal(calls[0].meta.topic, 't')
  } finally {
    scope.stop()
    await s.close()
  }
})

// ---------------------------------------------------------------- reactivity

test('a reactive topic resubscribes, and stops delivering the old one', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const name = ref('first')
    const value = scope.run(() => useTopic(name, null, { client }))

    await opened(client)
    await s.hub.publish('first', { n: 1 })
    await until(() => value.value, (v) => v?.n === 1)

    name.value = 'second'
    await nextTick()
    // Changing the topic set reconnects the shared stream (§9.3).
    await opened(client)

    await s.hub.publish('second', { n: 2 })
    await until(() => value.value, (v) => v?.n === 2)

    // The old subscription is gone, so this must not arrive. Nothing to wait *for*, so
    // wait a beat and assert it did not happen.
    await s.hub.publish('first', { n: 99 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(value.value.n, 2, 'the old topic must not still be delivering')
  } finally {
    scope.stop()
    await s.close()
  }
})

test('stopping the scope unsubscribes', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    const calls = []
    scope.run(() => useTopicEffect('t', (v) => calls.push(v), { client }))

    await opened(client)
    await s.hub.publish('t', { n: 1 })
    await until(() => calls, (c) => c.length === 1)

    scope.stop()

    await s.hub.publish('t', { n: 2 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(calls.length, 1, 'a stopped scope must not keep receiving')
  } finally {
    await s.close()
  }
})

test('useConnectionState reports the live state and reads it once on setup', async () => {
  const s = await boot()
  const scope = effectScope()
  try {
    const client = s.track(createClient({ url: s.url }))
    // Subscribe first so the client actually connects, then read the state late — the
    // case a change-listener-only implementation gets wrong, leaving the indicator on
    // `idle` because the connection opened before anyone was watching.
    client.subscribe('t', () => {})
    const state = scope.run(() => useConnectionState(client))

    await until(() => state.value, (v) => v === 'open')
  } finally {
    scope.stop()
    await s.close()
  }
})

// ---------------------------------------------------------------- wiring

test('useAghoz resolves the provided client, and says what to do when there is none', async () => {
  const s = await boot()
  try {
    const client = s.track(createClient({ url: s.url }))

    // App-level provide under the exported key, read through `runWithContext` — no DOM
    // and no component needed to prove the injection key is the one `useAghoz` reads.
    const app = createApp({})
    app.provide(AGHOZ_KEY, client)
    assert.equal(app.runWithContext(() => useAghoz()), client)

    // An explicit client always wins, which is what makes every composable usable
    // outside a component.
    assert.equal(useAghoz(client), client)

    assert.throws(() => createApp({}).runWithContext(() => useAghoz()), /provideAghoz/)
  } finally {
    await s.close()
  }
})

test('provideAghoz closes the client it created when the scope is disposed', async () => {
  const s = await boot()
  const scope = effectScope()
  const warn = console.warn
  try {
    // `provide()` outside a component setup warns and does nothing; the lifetime half
    // being tested here is independent of it.
    console.warn = () => {}
    const client = scope.run(() => provideAghoz({ url: s.url }))
    console.warn = warn

    client.subscribe('t', () => {})
    await until(() => client.state, (v) => v === 'open')

    scope.stop()
    assert.equal(client.state, 'closed', 'a client this created must be closed with the scope')
  } finally {
    console.warn = warn
    await s.close()
  }
})

test('provideAghoz leaves a client it was given alone', async () => {
  const s = await boot()
  const scope = effectScope()
  const warn = console.warn
  try {
    console.warn = () => {}
    const existing = s.track(createClient({ url: s.url }))
    const returned = scope.run(() => provideAghoz({ url: s.url, client: existing }))
    console.warn = warn

    assert.equal(returned, existing)
    scope.stop()
    // Supplied clients are the caller's; closing one here would tear down a connection
    // shared with whatever else is using it.
    assert.notEqual(existing.state, 'closed')
  } finally {
    console.warn = warn
    await s.close()
  }
})
