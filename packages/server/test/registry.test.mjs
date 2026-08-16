// Registry tests — PROTOCOL.md §4.5, §8.2, §9.3, §10.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from '../dist/registry.js'

test('matches only subscribers holding the topic', () => {
  const r = new Registry()
  const a = r.add(['org/1/orders', 'org/1/presence'])
  const b = r.add(['org/2/orders'])
  assert.ok(a.ok && b.ok)

  assert.deepEqual(r.match('org/1/orders'), [a.id])
  assert.deepEqual(r.match('org/2/orders'), [b.id])
  assert.deepEqual(r.match('org/1/presence'), [a.id])
  assert.deepEqual(r.match('org/3/orders'), [])
})

test('cross-tenant isolation holds after churn', () => {
  const r = new Registry()
  const tenantA = r.add(['org/1/orders'], 'user-a')
  const tenantB = r.add(['org/2/orders'], 'user-b')
  assert.ok(tenantA.ok && tenantB.ok)

  r.remove(tenantA.id)
  const tenantC = r.add(['org/3/orders'], 'user-c')
  assert.ok(tenantC.ok)

  // The recycled-id bug: if ids were reused, tenantC would inherit tenantA's number
  // and any in-flight write for tenantA would land on tenantC's socket.
  assert.notEqual(tenantC.id, tenantA.id)
  assert.deepEqual(r.match('org/1/orders'), [])
  assert.deepEqual(r.match('org/2/orders'), [tenantB.id])
})

test('duplicate topics in one subscription are collapsed', () => {
  const r = new Registry()
  const s = r.add(['a', 'a', 'b', 'a'])
  assert.ok(s.ok)
  // Otherwise the same socket receives the event twice with identical ids, which no
  // client-side dedupe can repair.
  assert.deepEqual(r.match('a'), [s.id])
  assert.deepEqual([...r.topicsOf(s.id)].sort(), ['a', 'b'])
})

test('remove is idempotent — both close events may fire', () => {
  const r = new Registry()
  const s = r.add(['a'])
  assert.ok(s.ok)
  assert.equal(r.remove(s.id), true)
  assert.equal(r.remove(s.id), false)
  assert.equal(r.size, 0)
})

test('1000 connect/abort cycles leak neither subscribers nor topic index entries', () => {
  const r = new Registry()
  for (let i = 0; i < 1000; i++) {
    const s = r.add([`org/${i}/orders`, `org/${i}/presence`], `user-${i}`)
    assert.ok(s.ok)
    r.remove(s.id)
  }
  assert.equal(r.size, 0, 'subscribers leaked')
  // The index is the subtler leak: per-entity topics mean the map grows without
  // bound unless empty sets are deleted, and nothing user-visible ever fails.
  assert.equal(r.topicCount, 0, 'topic index leaked')
  assert.equal(r.countForKey('user-0'), 0, 'per-key counter leaked')
})

test('enforces the process connection cap', () => {
  const r = new Registry({ maxConnections: 2 })
  assert.ok(r.add(['a']).ok)
  assert.ok(r.add(['a']).ok)
  const third = r.add(['a'])
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'max-connections')
})

test('enforces the per-key cap and releases it on remove', () => {
  const r = new Registry({ maxConnectionsPerKey: 2 })
  const a = r.add(['t'], 'user-7')
  const b = r.add(['t'], 'user-7')
  assert.ok(a.ok && b.ok)

  const c = r.add(['t'], 'user-7')
  assert.equal(c.ok, false)
  assert.equal(c.reason, 'max-connections-per-key')

  // A different user is unaffected — the cap is per key, not global.
  assert.ok(r.add(['t'], 'user-8').ok)

  r.remove(a.id)
  assert.equal(r.countForKey('user-7'), 1)
  assert.ok(r.add(['t'], 'user-7').ok, 'slot must be reusable after disconnect')
})

test('rejects empty and oversized topic sets', () => {
  const r = new Registry({ maxTopicsPerConnection: 3 })
  assert.equal(r.add([]).ok, false)
  assert.equal(r.add(['a', 'b', 'c']).ok, true)
  const tooMany = r.add(['a', 'b', 'c', 'd'])
  assert.equal(tooMany.ok, false)
  assert.equal(tooMany.reason, 'too-many-topics')
})

test('reports slow-consumer strictly above the threshold', () => {
  const r = new Registry({ maxBufferBytes: 1000 })
  const s = r.add(['a'])
  assert.ok(s.ok)

  assert.equal(r.noteBuffer(s.id, 0), 'ok')
  assert.equal(r.noteBuffer(s.id, 1000), 'ok', 'at the limit is not over it')
  assert.equal(r.noteBuffer(s.id, 1001), 'slow-consumer')

  // Absolute depth, not deltas: a drained socket recovers.
  assert.equal(r.noteBuffer(s.id, 0), 'ok')
})

test('buffer reports for an unknown subscriber are distinguishable from healthy ones', () => {
  const r = new Registry({ maxBufferBytes: 10 })
  const s = r.add(['a'])
  assert.ok(s.ok)
  r.remove(s.id)
  // A write completing after teardown must not read as 'ok' and resurrect anything.
  assert.equal(r.noteBuffer(s.id, 0), 'unknown')
})

// §8.2 — the delta pair, for hosts with no absolute socket depth to report.
//
// Node never uses these: `res.writableLength` is an absolute depth and the socket is a
// better authority than any accounting kept beside it. They exist because ASGI, net/http
// and Swoole all backpressure by suspending instead of exposing a queue, so without them
// §8.2 is unimplementable in most of the runtimes the C ABI exists to serve. The
// TypeScript core implements them to stay a faithful second implementation of the rule.

test('sent deltas accumulate to the same verdict an absolute report would give', () => {
  const delta = new Registry({ maxBufferBytes: 1000 })
  const absolute = new Registry({ maxBufferBytes: 1000 })
  const d = delta.add(['a'])
  const a = absolute.add(['a'])
  assert.ok(d.ok && a.ok)

  assert.equal(delta.noteSent(d.id, 600), 'ok')
  assert.equal(delta.noteSent(d.id, 400), 'ok', 'at the limit is not over it')
  assert.equal(delta.noteSent(d.id, 1), 'slow-consumer')

  // The same outstanding totals, reported the other way. §8.2 is a rule about
  // outstanding bytes, so how a host arrived at the number must not change the answer.
  assert.equal(absolute.noteBuffer(a.id, 600), 'ok')
  assert.equal(absolute.noteBuffer(a.id, 1000), 'ok')
  assert.equal(absolute.noteBuffer(a.id, 1001), 'slow-consumer')
})

test('a flush brings a slow consumer back under the cap', () => {
  const r = new Registry({ maxBufferBytes: 100 })
  const s = r.add(['a'])
  assert.ok(s.ok)
  assert.equal(r.noteSent(s.id, 150), 'slow-consumer')
  // Draining is recovery, not a one-way door — the verdict describes now, not a latch.
  assert.equal(r.noteFlushed(s.id, 100), 'ok')
  assert.equal(r.noteSent(s.id, 50), 'ok')
})

test('a flush for bytes never sent saturates at zero rather than going negative', () => {
  const r = new Registry({ maxBufferBytes: 100 })
  const s = r.add(['a'])
  assert.ok(s.ok)
  r.noteSent(s.id, 10)
  // A double count, or a frame written before the subscriber registered. Going negative
  // here would let the next 100 bytes of real backlog read as healthy.
  assert.equal(r.noteFlushed(s.id, 9999), 'ok')
  assert.equal(r.noteSent(s.id, 101), 'slow-consumer', 'the counter really is at zero')
})

test('the delta pair reports an unknown subscriber like noteBuffer does', () => {
  const r = new Registry({ maxBufferBytes: 10 })
  const s = r.add(['a'])
  assert.ok(s.ok)
  r.remove(s.id)
  // All three must agree, or a host using one style silently misses a drop the other
  // would have reported.
  assert.equal(r.noteBuffer(s.id, 0), 'unknown')
  assert.equal(r.noteSent(s.id, 1), 'unknown')
  assert.equal(r.noteFlushed(s.id, 1), 'unknown')
})
