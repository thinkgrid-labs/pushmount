// Parser tests — PROTOCOL.md §6.3.
//
// The headline test replays every conformance vector with a chunk boundary injected at
// every single byte offset. Chunk boundaries are where hand-rolled SSE parsers actually
// break, and they break intermittently, under load, in production.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SseParser, compareIds } from '../dist/parser.js'

const corpus = JSON.parse(
  readFileSync(new URL('../../../conformance/vectors.json', import.meta.url), 'utf8'),
)
const enc = new TextEncoder()

/** Feeds `text` as two chunks split at byte offset `at`. */
function parseSplitAt(text, at) {
  const bytes = enc.encode(text)
  const p = new SseParser()
  const events = [...p.push(bytes.slice(0, at)), ...p.push(bytes.slice(at)), ...p.end()]
  return events
}

test('every conformance frame parses identically at every chunk boundary', () => {
  for (const v of corpus.encode) {
    const bytes = enc.encode(v.frame)
    // Whole-frame parse establishes the expected value.
    const whole = new SseParser()
    const expected = [...whole.push(bytes), ...whole.end()]
    assert.equal(expected.length, 1, `${v.id} should yield exactly one event`)
    assert.equal(expected[0].event, v.topic, `${v.id} event`)
    assert.equal(expected[0].id, `${v.ms}-${v.seq}`, `${v.id} id`)

    for (let at = 0; at <= bytes.length; at++) {
      const got = parseSplitAt(v.frame, at)
      assert.deepEqual(
        got,
        expected,
        `${v.id} (${v.desc}) diverged when split at byte ${at} of ${bytes.length}`,
      )
    }
  }
})

test('a payload survives being split inside a multibyte character', () => {
  // "日" is three bytes; splitting between them must not produce replacement chars.
  const frame = 'id: 1-0\nevent: t\ndata: 日本語 🚀\n\n'
  const bytes = enc.encode(frame)
  for (let at = 0; at <= bytes.length; at++) {
    const got = parseSplitAt(frame, at)
    assert.equal(got.length, 1, `split at ${at}`)
    assert.equal(got[0].data, '日本語 🚀', `split at ${at}`)
  }
})

test('accepts CR, LF and CRLF terminators on input', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const frame = `id: 1-0${nl}event: t${nl}data: a${nl}data: b${nl}${nl}`
    const p = new SseParser()
    const got = [...p.push(enc.encode(frame)), ...p.end()]
    assert.equal(got.length, 1, `terminator ${JSON.stringify(nl)}`)
    assert.equal(got[0].data, 'a\nb', 'segments rejoin with LF regardless of input terminator')
  }
})

test('a CR arriving at the end of a chunk is not mistaken for a line end', () => {
  // The classic bug: emit on the CR, then see the LF and emit a second, empty event.
  const p = new SseParser()
  const first = p.push(enc.encode('id: 1-0\nevent: t\ndata: a\r'))
  const second = p.push(enc.encode('\n\r\n'))
  const rest = p.end()
  const all = [...first, ...second, ...rest]
  assert.equal(all.length, 1, `expected one event, got ${JSON.stringify(all)}`)
  assert.equal(all[0].data, 'a')
})

test('comments are discarded and never produce an event', () => {
  const p = new SseParser()
  const got = [...p.push(enc.encode(':ok\n\n:ka\n\n')), ...p.end()]
  assert.deepEqual(got, [], 'keep-alives must not surface as events')
})

test('an empty payload still dispatches — this deviates from EventSource on purpose', () => {
  // Strict SSE drops an event whose data buffer is empty. Vector E3 requires
  // publish(topic, '') to be delivered, so the parser dispatches on any field seen.
  // Owning the parser is what makes that choice available.
  const p = new SseParser()
  const got = [...p.push(enc.encode('id: 1-0\nevent: ping\ndata: \n\n')), ...p.end()]
  assert.equal(got.length, 1)
  assert.equal(got[0].data, '')
  assert.equal(got[0].event, 'ping')
})

test('control frames parse with no id, so they cannot advance a cursor', () => {
  const p = new SseParser()
  const got = [
    ...p.push(enc.encode('event: ~gap\ndata: {"reason":"slow-consumer","topics":[]}\n\n')),
    ...p.end(),
  ]
  assert.equal(got.length, 1)
  assert.equal(got[0].id, undefined)
  assert.equal(got[0].event, '~gap')
  assert.equal(JSON.parse(got[0].data).reason, 'slow-consumer')
})

test('unknown fields are ignored but do not suppress the event', () => {
  const p = new SseParser()
  const got = [
    ...p.push(enc.encode('id: 1-0\nretry: 5000\nfuture: x\nevent: t\ndata: v\n\n')),
    ...p.end(),
  ]
  assert.equal(got.length, 1)
  assert.equal(got[0].data, 'v')
  assert.equal(got[0].id, '1-0')
})

test('a field with no colon is a field name with an empty value', () => {
  const p = new SseParser()
  const got = [...p.push(enc.encode('id: 1-0\nevent: t\ndata\n\n')), ...p.end()]
  assert.equal(got.length, 1)
  assert.equal(got[0].data, '')
})

test('multiple frames in one chunk all surface, in order', () => {
  const p = new SseParser()
  const text =
    'id: 1-0\nevent: t\ndata: one\n\n' +
    ':ka\n\n' +
    'id: 1-1\nevent: t\ndata: two\n\n' +
    'id: 1-2\nevent: t\ndata: three\n\n'
  const got = [...p.push(enc.encode(text)), ...p.end()]
  assert.deepEqual(got.map((e) => e.data), ['one', 'two', 'three'])
  assert.deepEqual(got.map((e) => e.id), ['1-0', '1-1', '1-2'])
})

test('a frame delivered one byte at a time still parses', () => {
  const frame = 'id: 1755083412345-7\nevent: org/42/orders\ndata: {"a":1}\ndata: {"b":2}\n\n'
  const bytes = enc.encode(frame)
  const p = new SseParser()
  const got = []
  for (const b of bytes) got.push(...p.push(new Uint8Array([b])))
  got.push(...p.end())
  assert.equal(got.length, 1)
  assert.equal(got[0].data, '{"a":1}\n{"b":2}')
})

test('id comparison matches the corpus, and is not a string compare', () => {
  for (const v of corpus.idOrder) {
    const a = `${v.a[0]}-${v.a[1]}`
    const b = `${v.b[0]}-${v.b[1]}`
    assert.equal(Math.sign(compareIds(a, b)), v.cmp, `${v.id}: ${v.desc}`)
  }
  assert.equal(compareIds('1755083412345-7', '1755083412345-10'), -1)
})
