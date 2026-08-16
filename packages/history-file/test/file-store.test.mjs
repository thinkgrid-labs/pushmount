// The disk-backed store — two lives of a hub across a real file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, appendFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHub } from '@aghoz/server'
import { createFileStore, removeFileStore } from '../dist/index.js'

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), 'aghoz-history-'))
  return join(dir, 'events.log')
}

test('a hub restarted against the same file replays instead of reporting a gap', async () => {
  const path = await tempPath()

  const store = createFileStore({ path })
  const first = createHub({ keepAliveMs: 0, history: store })
  await first.ready()
  const a = await first.publish('t', 'one')
  await first.publish('t', 'two')
  await first.publish('t', 'three')
  // `hub.close()` does not await the store — it is synchronous by contract — so a
  // shutdown that must not lose the tail awaits the store itself. Double-closing is safe
  // precisely so this pattern works.
  first.close()
  await store.close()

  const second = createHub({ keepAliveMs: 0, history: createFileStore({ path }) })
  await second.ready()
  const handler = second.handler({})
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/events?topics=t`,
      { headers: { 'last-event-id': a.id } },
    )
    assert.equal(res.headers.get('last-event-id-checkpoint'), a.id, 'the file vouched for the cursor')

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 600
    while (Date.now() < deadline && buffer.split('\n\n').filter(Boolean).length < 3) {
      const r = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true }), 150)),
      ])
      if (r.done) break
      buffer += dec.decode(r.value, { stream: true })
    }
    reader.cancel().catch(() => {})

    assert.ok(buffer.includes('data: two'), `missing replay: ${JSON.stringify(buffer)}`)
    assert.ok(buffer.includes('data: three'))
  } finally {
    second.close()
    await new Promise((r) => server.close(r))
    await removeFileStore(path)
  }
})

test('events are written one JSON line each, in publish order', async () => {
  const path = await tempPath()
  const store = createFileStore({ path })
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  const ids = []
  for (const v of ['one', 'two', 'three']) ids.push((await hub.publish('t', v)).id)
  hub.close()
  await store.close()

  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).id),
    ids,
    'order is load-bearing — the ring assumes its oldest entry is at the head',
  )
  assert.equal(JSON.parse(lines[0]).payload, 'one')
  await removeFileStore(path)
})

test('§6.0 origin round-trips through the file', async () => {
  const path = await tempPath()
  const store = createFileStore({ path })
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  await hub.publish('t', 'v', { origin: 'tab-7' })
  hub.close()
  await store.close()

  const { events: restored } = await createFileStore({ path }).load()
  assert.equal(restored[0].origin, 'tab-7', 'a client still has to skip its own echo on replay')
  await removeFileStore(path)
})

test('a torn final line is dropped, because that is what a crash mid-append looks like', async () => {
  const path = await tempPath()
  await writeFile(path, '{"id":"1000-0","topic":"t","payload":"one"}\n')
  // Half a line, as an interrupted write leaves behind.
  await appendFile(path, '{"id":"1000-1","topic":"t","paylo')

  const { events } = await createFileStore({ path }).load()
  assert.equal(events.length, 1, 'the intact event survives')
  assert.equal(events[0].id, '1000-0')
  await removeFileStore(path)
})

test('a broken line in the middle is an error, not something to skip past', async () => {
  const path = await tempPath()
  await writeFile(
    path,
    '{"id":"1000-0","topic":"t","payload":"one"}\nnot json at all\n{"id":"1000-2","topic":"t","payload":"three"}\n',
  )
  // Only the last line can be torn. Damage anywhere else means the file is not what we
  // think it is, and reading on would silently skip real events.
  await assert.rejects(() => createFileStore({ path }).load(), /corrupt at line 2/)
  await removeFileStore(path)
})

test('a missing file is an ordinary first boot', async () => {
  const path = await tempPath()
  assert.deepEqual(await createFileStore({ path }).load(), { events: [] })
})

test('the log is compacted rather than growing without bound', async () => {
  const path = await tempPath()
  const store = createFileStore({ path, maxBytes: 2048 })
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()

  const ids = []
  for (let i = 0; i < 200; i++) ids.push((await hub.publish('t', `payload-${i}-${'x'.repeat(40)}`)).id)
  hub.close()
  await store.close()

  const size = (await stat(path)).size
  assert.ok(size <= 2048 * 2, `log grew to ${size}, past twice its budget`)

  // And what survived is the newest events, still in order and still parseable.
  const { events } = await createFileStore({ path, maxBytes: 2048 }).load()
  assert.ok(events.length > 0)
  assert.equal(events.at(-1).id, ids.at(-1), 'compaction keeps the newest, not the oldest')
  const restoredIds = events.map((e) => e.id)
  assert.deepEqual(restoredIds, [...restoredIds].sort(byId), 'order survives compaction')
  await removeFileStore(path)
})

test('a hub restored from a compacted log still reports a gap for a cursor it lost', async () => {
  const path = await tempPath()
  const store = createFileStore({ path, maxBytes: 1024 })
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  const oldest = await hub.publish('t', 'x'.repeat(200))
  for (let i = 0; i < 60; i++) await hub.publish('t', 'x'.repeat(200))
  hub.close()
  await store.close()

  const second = createHub({ keepAliveMs: 0, history: createFileStore({ path, maxBytes: 1024 }) })
  await second.ready()
  const handler = second.handler({})
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))
  try {
    // The oldest event was compacted away. Bounded durability must not turn into a
    // dishonest "nothing missed".
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/events?topics=t`,
      { headers: { 'last-event-id': oldest.id } },
    )
    assert.equal(res.headers.get('last-event-id-checkpoint'), 'earliest')
    await res.body.cancel()
  } finally {
    second.close()
    await new Promise((r) => server.close(r))
    await removeFileStore(path)
  }
})

test('losing the tail of the log is safe — the client is told, not left stale', async () => {
  const path = await tempPath()
  const store = createFileStore({ path })
  const hub = createHub({ keepAliveMs: 0, history: store })
  await hub.ready()
  await hub.publish('t', 'one')
  const lost = await hub.publish('t', 'two')
  hub.close()
  await store.close()

  // Simulate a hard crash that lost the last append: truncate the file to its first line.
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  await writeFile(path, `${lines[0]}\n`)

  const second = createHub({ keepAliveMs: 0, history: createFileStore({ path }) })
  await second.ready()
  const handler = second.handler({})
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, r))
  try {
    // The client's cursor is newer than anything the restored hub has seen. This is why
    // the store does not need to fsync per event: a short log costs a refetch, never
    // silence.
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/events?topics=t`,
      { headers: { 'last-event-id': lost.id } },
    )
    assert.equal(res.headers.get('last-event-id-checkpoint'), 'earliest')
    await res.body.cancel()
  } finally {
    second.close()
    await new Promise((r) => server.close(r))
    await removeFileStore(path)
  }
})

test('concurrent appends do not interleave into a torn line', async () => {
  const path = await tempPath()
  const store = createFileStore({ path })
  // Not awaited individually — exactly how the hub calls it from the publish path.
  const writes = []
  for (let i = 0; i < 50; i++) {
    writes.push(store.append({ id: `1000-${i}`, topic: 't', payload: `payload-${'y'.repeat(200)}-${i}` }))
  }
  await Promise.all(writes)
  await store.close()

  const { events } = await createFileStore({ path }).load()
  assert.equal(events.length, 50, 'every line parsed — no write tore another')
  assert.deepEqual(
    events.map((e) => e.id),
    Array.from({ length: 50 }, (_, i) => `1000-${i}`),
    'and they are in the order they were written',
  )
  await removeFileStore(path)
})

function byId(a, b) {
  const [am, as] = a.split('-').map(Number)
  const [bm, bs] = b.split('-').map(Number)
  return am !== bm ? am - bm : as - bs
}
