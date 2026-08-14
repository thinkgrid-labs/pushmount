// Authorization lifetime — PROTOCOL.md §4.3, §4.6.
//
// §4.3 authorizes once, at connect, so a stream outlives the decision that permitted
// it. The polling this library replaces re-authorized on every request; a long-lived
// stream does not, and that is the largest hole in the headline claim. These are the
// two halves of the answer: `revalidateMs` for the poll, `disconnect()` for the push.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHub } from '../dist/index.js'

async function boot(handlerOptions, hubOptions = {}) {
  const hub = createHub({ keepAliveMs: 0, ...hubOptions })
  const handler = hub.handler(handlerOptions)
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/events') return res.writeHead(404).end()
    void handler(req, res)
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

/** Opens a stream at the default `/events` mount. */
function open(base, query = 'topics=a') {
  return openAt(`${base}/events?${query}`)
}

/** Opens a stream at an exact URL and reports when the server ends it. */
async function openAt(url) {
  const ctrl = new AbortController()
  const res = await fetch(url, { signal: ctrl.signal })
  const state = { ended: false }
  if (res.body) {
    void (async () => {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch {
        /* aborted */
      }
      state.ended = true
    })()
  }
  return { res, state, close: () => ctrl.abort() }
}

async function until(predicate, ms = 3000, label = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('a connection whose authorization is revoked is closed', async () => {
  let permitted = true
  const s = await boot({ authorize: () => permitted, revalidateMs: 40 })
  try {
    const stream = await open(s.base)
    assert.equal(stream.res.status, 200)
    await until(() => s.hub.connectionCount() === 1, 2000, 'subscribe')

    // The session is revoked server-side — a logout elsewhere, a role change, an
    // expired subscription. Nothing about the connection itself changed.
    permitted = false

    await until(() => s.hub.connectionCount() === 0, 2000, 'eviction')
    await until(() => stream.state.ended, 2000, 'stream end')
    stream.close()
  } finally {
    await s.close()
  }
})

test('a connection still authorized is left alone', async () => {
  let checks = 0
  const s = await boot({
    authorize: () => {
      checks++
      return true
    },
    revalidateMs: 30,
  })
  try {
    const stream = await open(s.base)
    await until(() => s.hub.connectionCount() === 1, 2000, 'subscribe')
    await until(() => checks > 3, 2000, 'several revalidations')

    // Revalidation is not a disconnect with extra steps.
    assert.equal(s.hub.connectionCount(), 1)
    assert.equal(stream.state.ended, false)

    // And events still flow through a connection that has been revalidated.
    const ack = await s.hub.publish('a', 'still here')
    assert.equal(ack.delivered, 1)
    stream.close()
  } finally {
    await s.close()
  }
})

test('an authorizer that throws during revalidation fails closed', async () => {
  let live = false
  const errors = []
  const s = await boot(
    {
      authorize: () => {
        if (live) throw new Error('the session store is down')
        return true
      },
      revalidateMs: 40,
    },
    { onError: (e) => errors.push(e) },
  )
  try {
    const stream = await open(s.base)
    await until(() => s.hub.connectionCount() === 1, 2000, 'subscribe')

    live = true
    // At connect a throw is a 500, because no stream exists yet. Here one does, and
    // its authorization is unknown — the only safe reading of unknown is no.
    await until(() => s.hub.connectionCount() === 0, 2000, 'eviction')
    assert.match(errors[0].message, /session store is down/)
    stream.close()
  } finally {
    await s.close()
  }
})

test('revalidation only re-runs the authorizer that admitted the connection', async () => {
  // One hub, two mounts, two different authorizers — a public feed and an admin feed.
  // Re-running the wrong one would evict connections that are perfectly valid.
  const hub = createHub({ keepAliveMs: 0 })
  let adminPermitted = true
  const publicHandler = hub.handler({ authorize: () => true, revalidateMs: 40 })
  const adminHandler = hub.handler({ authorize: () => adminPermitted, revalidateMs: 40 })

  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/events') return void publicHandler(req, res)
    if (path === '/admin') return void adminHandler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const pub = await open(base, 'topics=a')
    const adminStream = await openAt(`${base}/admin?topics=a`)
    await until(() => hub.connectionCount() === 2, 2000, 'both connected')

    adminPermitted = false
    await until(() => hub.connectionCount() === 1, 2000, 'admin evicted')
    await until(() => adminStream.state.ended, 2000, 'admin stream end')

    // The public connection is untouched: its own authorizer never said otherwise.
    assert.equal(pub.state.ended, false)
    pub.close()
    adminStream.close()
  } finally {
    hub.close()
    await new Promise((r) => server.close(r))
  }
})

test('closing the hub stops revalidating', async () => {
  let checks = 0
  const s = await boot({
    authorize: () => {
      checks++
      return true
    },
    revalidateMs: 25,
  })
  const stream = await open(s.base)
  await until(() => checks > 2, 2000, 'revalidation running')

  await s.close()
  const afterClose = checks
  await new Promise((r) => setTimeout(r, 120))
  // A closed hub that keeps calling into application code is a leak with a callback
  // attached to it.
  assert.equal(checks, afterClose)
  stream.close()
})
