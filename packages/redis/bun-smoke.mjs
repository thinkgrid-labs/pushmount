// Redis Streams compatibility gate for a Bun-hosted Aghoz deployment.

import assert from 'node:assert/strict'
import Redis from 'ioredis'
import { createHub } from '@aghoz/server'
import { createRedisBackplane } from './dist/index.js'

assert.ok(process.versions.bun, 'this smoke test must run under Bun')

const port = Number(process.env.REDIS_PORT ?? 6379)
const key = `aghoz:bun-smoke:${process.pid}:${Date.now()}`
const clients = []

function redis() {
  const client = new Redis({
    host: '127.0.0.1',
    port,
    connectTimeout: 2_000,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  })
  // The awaited command still rejects and fails the smoke test. This listener prevents
  // ioredis from also printing an unhandled EventEmitter error while doing so.
  client.on('error', () => {})
  clients.push(client)
  return client
}

async function makeNode() {
  const backplane = await createRedisBackplane({
    redis: redis(),
    subscriber: redis(),
    key,
    blockMs: 100,
  })
  const hub = createHub({ keepAliveMs: 0, backplane })
  await hub.ready()
  return { hub, backplane }
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('timed out waiting for Redis fan-out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let first
let second

try {
  const probe = redis()
  assert.equal(await probe.ping(), 'PONG')

  first = await makeNode()
  second = await makeNode()

  const published = await first.hub.publish('admin/catalog/books', { status: 'pending' })
  await waitFor(() => second.hub.cursor() === published.id)

  const replay = await second.backplane.replay('0-0', ['admin/catalog/books'])
  assert.equal(replay.truncated, false)
  assert.equal(replay.events.length, 1)
  assert.equal(replay.events[0].id, published.id)
  assert.deepEqual(JSON.parse(replay.events[0].payload), { status: 'pending' })

  console.log(`bun ${process.versions.bun}: Redis Streams fan-out and replay smoke passed`)
} finally {
  first?.hub.close()
  second?.hub.close()

  const cleanup = clients[0]
  if (cleanup !== undefined) await cleanup.del(key, `${key}:floor`).catch(() => {})
  for (const client of clients) client.disconnect()
}
