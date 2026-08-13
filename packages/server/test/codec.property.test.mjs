// Property tests for the frame codec — PROTOCOL.md §6.1.
//
// The conformance corpus pins specific inputs. These assert the invariant behind them
// for arbitrary input, which is the version that actually protects against injection:
// a fixed vector only proves the encoder handles the payloads someone thought of.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, encodeControl, validTopic } from '../dist/hub.js'

const dec = new TextDecoder()

// Deterministic PRNG so a failure is reproducible from the seed alone.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5;  s >>>= 0
    return s / 0x100000000
  }
}

// Weighted toward the characters that break line-oriented formats.
const ALPHABET = [
  '\n', '\r', '\r\n', '\n\n', '\0', ':', ' ', 'a', 'z', '{', '}', '"', '\\',
  'data: ', 'event: ', 'id: ', '~gap', '日', '🚀', '', '', 'é',
]

function randomPayload(rand, maxLen = 40) {
  const n = Math.floor(rand() * maxLen)
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return out
}

/**
 * A deliberately literal SSE decoder, used as the oracle. Written straight from the
 * spec and kept naive on purpose — an oracle that shares the encoder's cleverness
 * shares its bugs.
 */
function decodeSingleFrame(text) {
  assert.ok(text.endsWith('\n\n'), 'frame must end with a blank line')
  const lines = text.slice(0, -2).split('\n')
  const fields = { id: undefined, event: undefined, data: [] }
  for (const line of lines) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    assert.notEqual(colon, -1, `line is not a field: ${JSON.stringify(line)}`)
    const name = line.slice(0, colon)
    let value = line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'data') fields.data.push(value)
    else fields[name] = value
  }
  return { id: fields.id, event: fields.event, data: fields.data.join('\n') }
}

/** §6.1 — CR and CRLF are normalised to LF. This is lossy and normative. */
const normalise = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

test('round-trips any payload, modulo the normative CR normalisation', () => {
  const rand = rng(0xc0ffee)
  for (let i = 0; i < 5000; i++) {
    const payload = randomPayload(rand)
    const frame = dec.decode(encodeFrame(1755083412345, i, 'org/42/orders', payload))
    const got = decodeSingleFrame(frame)
    assert.equal(got.data, normalise(payload), `payload ${JSON.stringify(payload)}`)
    assert.equal(got.event, 'org/42/orders')
    assert.equal(got.id, `1755083412345-${i}`)
  }
})

test('no payload can inject a field — every line after the header is a data line', () => {
  const rand = rng(0x5eed)
  for (let i = 0; i < 5000; i++) {
    const payload = randomPayload(rand)
    const frame = dec.decode(encodeFrame(1, 0, 't', payload))
    const lines = frame.slice(0, -2).split('\n')
    assert.ok(lines[0].startsWith('id: '), 'first line is the id')
    assert.ok(lines[1].startsWith('event: '), 'second line is the event')
    for (let j = 2; j < lines.length; j++) {
      assert.ok(
        lines[j].startsWith('data: '),
        `payload ${JSON.stringify(payload)} injected line ${JSON.stringify(lines[j])}`,
      )
    }
  }
})

test('a frame is exactly one event — no payload can terminate it early', () => {
  const rand = rng(0xbeef)
  for (let i = 0; i < 5000; i++) {
    const frame = dec.decode(encodeFrame(1, 0, 't', randomPayload(rand)))
    // The terminating blank line must be the only one in the frame.
    assert.equal(frame.split('\n\n').length, 2)
  }
})

test('the id line is always parseable back to the ids that produced it', () => {
  const rand = rng(0xf00d)
  for (let i = 0; i < 2000; i++) {
    const ms = Math.floor(rand() * Number.MAX_SAFE_INTEGER)
    const seq = Math.floor(rand() * 1e6)
    const frame = dec.decode(encodeFrame(ms, seq, 't', 'x'))
    const idLine = frame.slice(4, frame.indexOf('\n'))
    assert.equal(idLine, `${ms}-${seq}`)
    assert.match(idLine, /^\d+-\d+$/, 'no exponent, separator or sign may appear')
  }
})

test('control frames carry no id, so they cannot advance a cursor', () => {
  for (const [name, data] of [
    ['gap', { reason: 'history-truncated', topics: ['a'] }],
    ['denied', { topics: ['org/99/orders'] }],
    ['gap', { reason: 'slow-consumer', topics: [] }],
  ]) {
    const frame = dec.decode(encodeControl(name, data))
    const got = decodeSingleFrame(frame)
    assert.equal(got.id, undefined, 'control frames must not carry id:')
    assert.equal(got.event, `~${name}`)
    assert.deepEqual(JSON.parse(got.data), data)
  }
})

test('control frame payloads cannot inject, because JSON escapes the terminators', () => {
  const rand = rng(0x1234)
  for (let i = 0; i < 2000; i++) {
    const topic = randomPayload(rand, 12)
    const frame = dec.decode(encodeControl('denied', { topics: [topic] }))
    assert.equal(frame.split('\n\n').length, 2, `topic ${JSON.stringify(topic)} escaped the frame`)
    assert.deepEqual(JSON.parse(decodeSingleFrame(frame).data).topics, [topic])
  }
})

test('every topic the validator accepts is safe to place in an event field', () => {
  const rand = rng(0xabcd)
  for (let i = 0; i < 5000; i++) {
    const topic = randomPayload(rand, 20)
    if (!validTopic(topic)) continue
    const frame = dec.decode(encodeFrame(1, 0, topic, 'x'))
    const got = decodeSingleFrame(frame)
    assert.equal(got.event, topic)
    assert.equal(frame.split('\n\n').length, 2)
    assert.ok(!got.event.startsWith('~'), 'accepted topic must not look like a control frame')
  }
})
