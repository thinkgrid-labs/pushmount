// Conformance runner for any JavaScript-side implementation.
//
//   node runner.mjs <path-to-module>
//
// The module under test must export:
//   encodeFrame(ms, seq, topic, payload, origin?) -> Uint8Array
//   validTopic(topic)                    -> boolean
//   validOrigin(origin)                  -> boolean
//   compareIds([msA,seqA], [msB,seqB])   -> -1 | 0 | 1
//   validId(raw)                         -> boolean
//   newHub(maxHistoryBytes?)             -> {
//     publish(nowMs, topic, payload, origin?) -> Uint8Array
//     append(id, topic, payload, origin?)     -> Uint8Array
//     encode(id, topic, payload, origin?)     -> Uint8Array
//     cursor()                                -> '<ms>-<seq>'
//     checkpoint(cursor)                      -> 'absent' | 'echo' | 'earliest'
//   }
//     where `cursor` is null or [ms, seq], and `checkpoint` subscribes to topic 't'.
//   newBufferHub(maxBufferBytes)         -> {
//     buffer(n) | sent(n) | flushed(n)        -> 'ok' | 'slow-consumer' | 'unknown'
//   }
//     one subscriber, already registered, on a hub capped at `maxBufferBytes`.
//
// Exits non-zero on any divergence. This is the gate PROTOCOL.md §12 describes; it is
// the only thing that makes more than one implementation of the hub safe.

import { readFileSync } from 'node:fs'

const target = process.argv[2]
if (!target) {
  console.error('usage: node runner.mjs <path-to-module>')
  process.exit(2)
}

const impl = await import(new URL(target, `file://${process.cwd()}/`).href)
const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const dec = new TextDecoder()

let pass = 0
const failures = []

function check(id, desc, expected, actual) {
  if (Object.is(expected, actual)) { pass++; return }
  failures.push({ id, desc, expected, actual })
}

// ---- §6.1 encoding
for (const v of vectors.encode) {
  let actual
  try {
    actual = dec.decode(impl.encodeFrame(v.ms, v.seq, v.topic, v.payload, v.origin))
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.frame, actual)
}

// ---- §3 topic validation
for (const v of vectors.topic) {
  let actual
  try {
    actual = impl.validTopic(v.topic)
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.valid, actual)
}

// ---- §6.0 origin validation
for (const v of vectors.origin) {
  let actual
  try {
    actual = impl.validOrigin(v.origin)
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.valid, actual)
}

// ---- §2.1 id comparison
for (const v of vectors.idOrder) {
  let actual
  try {
    actual = Math.sign(impl.compareIds(v.a, v.b))
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.cmp, actual)
}

// ---- §2.1 id parsing
for (const v of vectors.idParse) {
  let actual
  try {
    actual = impl.validId(v.raw)
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.valid, actual)
}

// ---- the externally-assigned-id path (append / encode)
for (const v of vectors.append) {
  let actual
  try {
    const hub = impl.newHub()
    const frames = []
    for (const [kind, ...args] of v.ops) {
      // JSON has no undefined, so an absent origin arrives as null.
      const origin = args[3] ?? undefined
      if (kind === 'publish') frames.push(dec.decode(hub.publish(args[0], args[1], args[2], origin)))
      else if (kind === 'append') frames.push(dec.decode(hub.append(args[0], args[1], args[2], origin)))
      else if (kind === 'encode') frames.push(dec.decode(hub.encode(args[0], args[1], args[2], origin)))
      else throw new Error(`unknown op: ${kind}`)
    }
    actual = JSON.stringify({ frames, cursor: hub.cursor() })
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, JSON.stringify({ frames: v.frames, cursor: v.cursor }), actual)
}

// ---- §2.2 monotonicity
for (const v of vectors.monotonic) {
  let actual
  try {
    const hub = impl.newHub()
    const ids = v.nowMs.map((ms) => {
      const frame = dec.decode(hub.publish(ms, 't', 'x'))
      return frame.slice(4, frame.indexOf('\n'))
    })
    actual = ids.join(',')
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.expected.join(','), actual)
}

// ---- §4.5 / §7.1 the checkpoint decision
for (const v of vectors.checkpoint) {
  let actual
  try {
    const hub = impl.newHub(v.maxHistoryBytes)
    for (const [nowMs, topic, payload] of v.publishes) hub.publish(nowMs, topic, payload)
    actual = hub.checkpoint(v.cursor)
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.expected, actual)
}

// ---- §8.2 backpressure
for (const v of vectors.buffer) {
  let actual
  try {
    const hub = impl.newBufferHub(v.maxBufferBytes)
    const verdicts = []
    for (const [kind, n] of v.ops) {
      if (kind === 'buffer') verdicts.push(hub.buffer(n))
      else if (kind === 'sent') verdicts.push(hub.sent(n))
      else if (kind === 'flushed') verdicts.push(hub.flushed(n))
      else throw new Error(`unknown op: ${kind}`)
    }
    actual = verdicts.join(',')
  } catch (e) {
    actual = `threw: ${e.message}`
  }
  check(v.id, v.desc, v.expected.join(','), actual)
}

// ---- report
const total = pass + failures.length
if (failures.length === 0) {
  console.log(`conformance: ${pass}/${total} vectors pass — ${target}`)
  process.exit(0)
}

console.error(`conformance: ${pass}/${total} pass, ${failures.length} FAIL — ${target}\n`)
for (const f of failures) {
  console.error(`  ${f.id}  ${f.desc}`)
  console.error(`      expected: ${JSON.stringify(f.expected)}`)
  console.error(`      actual:   ${JSON.stringify(f.actual)}\n`)
}
process.exit(1)
