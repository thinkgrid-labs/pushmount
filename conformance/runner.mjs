// Conformance runner for any JavaScript-side implementation.
//
//   node runner.mjs <path-to-module>
//
// The module under test must export:
//   encodeFrame(ms, seq, topic, payload) -> Uint8Array
//   validTopic(topic)                    -> boolean
//   compareIds([msA,seqA], [msB,seqB])   -> -1 | 0 | 1
//   newHub()                             -> { publish(nowMs, topic, payload) -> Uint8Array }
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
    actual = dec.decode(impl.encodeFrame(v.ms, v.seq, v.topic, v.payload))
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
