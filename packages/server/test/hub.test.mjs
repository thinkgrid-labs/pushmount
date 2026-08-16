// Hub tests — PROTOCOL.md §2, §4.5, §5, §10.
// The codec and id rules are covered by the conformance corpus; this covers the parts
// the corpus does not reach: the ring, the checkpoint decision, and cursor parsing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hub, parseId, formatId, compareIds } from '../dist/hub.js'

const dec = new TextDecoder()
const idOf = (frame) => dec.decode(frame).slice(4, dec.decode(frame).indexOf('\n'))

test('rejects an invalid topic at publish, not at encode', () => {
  const hub = new Hub()
  for (const bad of ['', '~gap', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(256), '日'.repeat(86)]) {
    assert.throws(() => hub.publish(1000, bad, 'x'), TypeError, `should reject ${JSON.stringify(bad.slice(0, 20))}`)
  }
  // A rejected publish must not consume an id or leave a hole in the sequence.
  assert.equal(hub.cursor(), '0-0')
  assert.equal(hub.historyLength, 0)
})

test('cursor() reports the newest assigned id, and 0-0 before anything is published', () => {
  const hub = new Hub()
  assert.equal(hub.cursor(), '0-0')
  hub.publish(1000, 't', 'a')
  assert.equal(hub.cursor(), '1000-0')
  hub.publish(1000, 't', 'b')
  assert.equal(hub.cursor(), '1000-1')
  hub.publish(1001, 't', 'c')
  assert.equal(hub.cursor(), '1001-0')
})

test('history is bounded in bytes, not events', () => {
  const hub = new Hub({ maxHistoryBytes: 800 })
  for (let i = 0; i < 200; i++) hub.publish(1000 + i, 't', 'x'.repeat(100))
  assert.ok(hub.historyBytes <= 800, `bytes = ${hub.historyBytes}`)
  assert.ok(hub.historyLength < 200)

  // The same byte budget must hold far more small events than large ones — that is
  // the entire point of bounding bytes rather than count.
  const small = new Hub({ maxHistoryBytes: 800 })
  for (let i = 0; i < 200; i++) small.publish(1000 + i, 't', 'x')
  assert.ok(small.historyLength > hub.historyLength)
})

test('no cursor means no replay and no gap', () => {
  const hub = new Hub()
  hub.publish(1000, 't', 'a')
  const r = hub.checkpointAndReplay(null, ['t'])
  assert.equal(r.truncated, false)
  assert.deepEqual(r.frames, [])
})

test('replays strictly newer events, filtered by subscribed topic', () => {
  const hub = new Hub()
  const first = hub.publish(1000, 'a', '1')
  hub.publish(1001, 'b', '2')
  hub.publish(1002, 'a', '3')

  const r = hub.checkpointAndReplay(first.id, ['a'])
  assert.equal(r.truncated, false)
  assert.equal(r.frames.length, 1, 'the cursor event itself is not replayed')
  assert.equal(idOf(r.frames[0]), '1002-0')

  const both = hub.checkpointAndReplay(first.id, ['a', 'b'])
  assert.deepEqual(both.frames.map(idOf), ['1001-0', '1002-0'])

  const unsubscribed = hub.checkpointAndReplay(first.id, ['c'])
  assert.deepEqual(unsubscribed.frames, [])
})

test('a cursor at the newest event replays nothing and reports no gap', () => {
  const hub = new Hub()
  hub.publish(1000, 't', 'a')
  const last = hub.publish(1001, 't', 'b')
  const r = hub.checkpointAndReplay(last.id, ['t'])
  assert.equal(r.truncated, false)
  assert.deepEqual(r.frames, [])
})

test('a cursor older than retained history reports truncated', () => {
  const hub = new Hub({ maxHistoryBytes: 300 })
  const oldest = hub.publish(1000, 't', 'x'.repeat(80))
  for (let i = 1; i < 40; i++) hub.publish(1000 + i, 't', 'x'.repeat(80))

  const r = hub.checkpointAndReplay(oldest.id, ['t'])
  assert.equal(r.truncated, true, 'history moved past the cursor and must say so')
})

test('an empty hub reports a gap for a cursor it never issued', () => {
  // This assertion used to be the opposite, on the reasoning that an empty hub "has
  // nothing to have lost". That is the wrong intuition and it hid a real hole: an empty
  // hub is also what a *restarted* one looks like, and a client resuming with a cursor
  // from before the restart was told it had missed nothing. Everything published before
  // the shutdown was then gone with nobody informed — silent staleness, which is the one
  // failure §0 exists to eliminate. A hub that has never issued an id this high cannot
  // know what came after it. Conformance vectors CP8 and CP10.
  const hub = new Hub()
  const r = hub.checkpointAndReplay({ ms: 1, seq: 0 }, ['t'])
  assert.equal(r.truncated, true)
  assert.deepEqual(r.frames, [])
})

test('but the cold-start cursor on an empty hub is not a gap', () => {
  // The other half, and the one D6 exists to protect: `0-0` is what §5 hands a page on
  // its first load, and reporting a gap for it teaches people to ignore the signal.
  const hub = new Hub()
  const r = hub.checkpointAndReplay({ ms: 0, seq: 0 }, ['t'])
  assert.equal(r.truncated, false)
  assert.deepEqual(r.frames, [])
})

test('the checkpoint and the replay set describe the same instant', () => {
  // §4.5 requires these to be one operation. If they were two calls, a publish
  // between them could trim history after the checkpoint said "fine", under-reporting
  // a real gap. The API shape is the guarantee; this pins it.
  const hub = new Hub({ maxHistoryBytes: 400 })
  const oldest = hub.publish(1000, 't', 'x'.repeat(90))
  for (let i = 1; i < 20; i++) hub.publish(1000 + i, 't', 'x'.repeat(90))

  const r = hub.checkpointAndReplay(oldest.id, ['t'])
  if (r.truncated) {
    // Whatever is replayed must still be newer than the cursor.
    for (const f of r.frames) {
      const [ms, seq] = idOf(f).split('-').map(Number)
      assert.equal(compareIds({ ms, seq }, oldest.id), 1)
    }
  }
})

test('parseId accepts only canonical decimal ids', () => {
  assert.deepEqual(parseId('0-0'), { ms: 0, seq: 0 })
  assert.deepEqual(parseId('1755083412345-7'), { ms: 1755083412345, seq: 7 })

  for (const bad of [
    '', '1', '-0', '1-', '01-0', '1-00', 'a-b', '1e5-0', ' 1-0', '1-0 ',
    '+1-0', '1.0-0', '1-0-0', '99999999999999999-0',
  ]) {
    assert.equal(parseId(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})

test('parseId round-trips formatId', () => {
  for (const id of [{ ms: 0, seq: 0 }, { ms: 1755083412345, seq: 7 }, { ms: 9007199254740991, seq: 0 }]) {
    assert.deepEqual(parseId(formatId(id)), id)
  }
})

test('ids compare numerically, never as strings', () => {
  const a = { ms: 1755083412345, seq: 7 }
  const b = { ms: 1755083412345, seq: 10 }
  assert.equal(compareIds(a, b), -1)
  // The bug this guards: a string compare puts "…-10" before "…-7", so a client would
  // discard live events as already-seen.
  assert.ok(formatId(b) < formatId(a), 'string order really is the wrong way round')
})
