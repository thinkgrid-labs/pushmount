// Svelte store tests.
//
// Against a real hub over a real socket, like the rest of this repo's binding tests: the
// point of a binding is what it does with a live connection, and a mocked client would
// only prove the wrapper calls itself.
//
// No compiler and no DOM. These are `svelte/store` readables, which is exactly why they
// are stores rather than runes — plain JavaScript, subscribable from anywhere, and
// identical to what a component gets from `$topicStore`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '@aghoz/server'
import { createClient } from '@aghoz/client'
import {
  connectionState,
  getAghozClient,
  topic,
  topicEffect,
  topicReducer,
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
    client() {
      const c = createClient({ url: `http://127.0.0.1:${server.address().port}/events` })
      clients.push(c)
      return c
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

async function until(read, predicate, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out at ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** What `$store` does in a component, done by hand. */
function collect(store) {
  const values = []
  const unsubscribe = store.subscribe((v) => values.push(v))
  return { values, last: () => values[values.length - 1], unsubscribe }
}

// ---------------------------------------------------------------- values

test('topic holds the most recent value', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const seen = collect(topic('orders', null, { client }))

    // A readable emits its initial value to every new subscriber immediately.
    assert.equal(seen.last(), null)
    await opened(client)

    await s.hub.publish('orders', { id: 'ord_1' })
    await until(seen.last, (v) => v?.id === 'ord_1')

    await s.hub.publish('orders', { id: 'ord_2' })
    // A last-value cell: the second event replaces the first rather than accumulating.
    await until(seen.last, (v) => v?.id === 'ord_2')

    seen.unsubscribe()
  } finally {
    await s.close()
  }
})

test('parse defaults to JSON.parse and can be replaced', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const seen = collect(topic('t', '', { client, parse: (raw) => raw }))

    await opened(client)
    // Published as a bare string that is not valid JSON — the case the default would
    // throw on, which is why the default is not a guess-and-fall-back.
    await s.hub.publish('t', 'not json')
    await until(seen.last, (v) => v === 'not json')

    seen.unsubscribe()
  } finally {
    await s.close()
  }
})

test('topicReducer folds events into a collection', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const seen = collect(
      topicReducer('orders', (state, value) => [...state, value.id], [], { client }),
    )

    await opened(client)
    await s.hub.publish('orders', { id: 'a' })
    await s.hub.publish('orders', { id: 'b' })
    await until(seen.last, (v) => v.length === 2)
    assert.deepEqual(seen.last(), ['a', 'b'])

    seen.unsubscribe()
  } finally {
    await s.close()
  }
})

test('topicEffect runs without holding state, and receives event metadata', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const calls = []
    const stop = topicEffect('t', (value, meta) => calls.push({ value, meta }), { client })

    await opened(client)
    await s.hub.publish('t', { n: 1 })
    await until(() => calls, (c) => c.length === 1)
    assert.deepEqual(calls[0].value, { n: 1 })
    assert.match(calls[0].meta.id, /^\d+-\d+$/)
    assert.equal(calls[0].meta.topic, 't')

    // Unlike the stores there is no `$` subscription governing this one's lifetime, so
    // the returned function is the only way to end it.
    stop()
    await s.hub.publish('t', { n: 2 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(calls.length, 1)
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- lifetime

test('the last unsubscriber tears the subscription down', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const store = topic('t', null, { client })

    const a = collect(store)
    const b = collect(store)
    await opened(client)

    await s.hub.publish('t', { n: 1 })
    await until(a.last, (v) => v?.n === 1)
    await until(b.last, (v) => v?.n === 1)

    // One leaving is not enough — the store is still live for the other.
    a.unsubscribe()
    await s.hub.publish('t', { n: 2 })
    await until(b.last, (v) => v?.n === 2)

    // With the last one gone the readable's teardown runs, which is what makes `$` auto-
    // subscription in a component the whole subscription lifecycle: nothing to remember.
    b.unsubscribe()
    const before = b.values.length
    await s.hub.publish('t', { n: 3 })
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(b.values.length, before, 'a store with no subscribers must not still receive')
  } finally {
    await s.close()
  }
})

test('a reducer restarts from its initial state when resubscribed', async () => {
  const s = await boot()
  try {
    const client = s.client()
    const store = topicReducer('t', (state, value) => [...state, value.n], [], { client })

    const first = collect(store)
    await opened(client)
    await s.hub.publish('t', { n: 1 })
    await until(first.last, (v) => v.length === 1)
    first.unsubscribe()

    // A fold is only meaningful over an unbroken run of events. Carrying the old state
    // across a gap in subscription would be a fold over events it never saw, so the run
    // starts again — the alternative is a list that silently skips whatever happened
    // while nobody was listening.
    const second = collect(store)
    assert.deepEqual(second.last(), [], 'a new run starts from initial')

    await s.hub.publish('t', { n: 2 })
    await until(second.last, (v) => v.length === 1)
    assert.deepEqual(second.last(), [2])

    second.unsubscribe()
  } finally {
    await s.close()
  }
})

test('connectionState reports the live state and reads it once on start', async () => {
  const s = await boot()
  try {
    const client = s.client()
    // Subscribe first so the client actually connects, then build the store late — the
    // case a change-listener-only implementation gets wrong, leaving the indicator on
    // `idle` because the connection opened before anyone was watching.
    client.subscribe('t', () => {})
    await opened(client)

    const seen = collect(connectionState(client))
    await until(seen.last, (v) => v === 'open')

    seen.unsubscribe()
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------- wiring

test('an explicit client is always usable, and the error says what to do without one', async () => {
  const s = await boot()
  try {
    const client = s.client()
    assert.equal(getAghozClient(client), client)

    // Outside component initialisation Svelte's own `getContext` throws an error about
    // its internals. Both failures have the same two fixes, so both get the message that
    // names them.
    assert.throws(() => getAghozClient(), /setAghozClient|pass one explicitly/)
    assert.throws(() => topic('t', null), /setAghozClient|pass one explicitly/)
  } finally {
    await s.close()
  }
})
