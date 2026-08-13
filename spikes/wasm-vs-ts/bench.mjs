// Spike B — does the Rust core need a native (napi) binding, or is wasm enough?
//
// The build plan claims this is not a throughput problem, and that wasm is therefore
// an acceptable binding rather than a compromise. That claim decides whether we ship a
// six-platform prebuild matrix and inherit the `.node` bundler problems, so it gets
// measured rather than asserted.
//
//   node bench.mjs

import { createRequire } from 'node:module'
import { Hub as TsHub, encodeFrame } from './ts/hub.mjs'

const require = createRequire(import.meta.url)
const wasm = require('./pkg/pushmount_spike.js')

const dec = new TextDecoder()

// ---------------------------------------------------------------- equivalence gate

const VECTORS = [
  ['org/42/orders', '{"id":"ord_918"}'],
  ['chat', 'hello\n\nevent: ~gap\ndata: forged'],   // V2 — the injection vector
  ['ping', ''],
  ['crlf', 'a\r\nb\rc\nd'],
  ['unicode', '{"name":"日本語 — émoji 🚀"}'],
]

let mismatches = 0
for (const [topic, payload] of VECTORS) {
  const a = new wasm.Hub(1 << 20)
  const b = new TsHub(1 << 20)
  const fa = dec.decode(a.publish(1755083412346, topic, payload))
  const fb = dec.decode(b.publish(1755083412346, topic, payload))
  if (fa !== fb) {
    mismatches++
    console.error(`MISMATCH ${topic}\n  wasm: ${JSON.stringify(fa)}\n  ts:   ${JSON.stringify(fb)}`)
  }
}

// Topic validation must agree too.
for (const t of ['', 'a\nb', 'a\rb', 'a\0b', '~gap', '~', 'x'.repeat(256), 'x'.repeat(255), 'org/42/o']) {
  const a = wasm.Hub.valid_topic(t)
  const b = TsHub.validTopic(t)
  if (a !== b) { mismatches++; console.error(`MISMATCH validTopic(${JSON.stringify(t)}): wasm=${a} ts=${b}`) }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} divergence(s). The spike is invalid until these agree.`)
  process.exit(1)
}
console.log('equivalence: wasm and TS produce byte-identical frames on all vectors\n')

// ---------------------------------------------------------------------- benchmark

function bench(label, fn, ops) {
  fn(Math.min(ops, 20_000))                       // warm
  const t0 = process.hrtime.bigint()
  fn(ops)
  const ns = Number(process.hrtime.bigint() - t0)
  return { label, opsPerSec: (ops / ns) * 1e9, usPerOp: ns / ops / 1000 }
}

function makeRun(HubCtor, subCount, payload) {
  return (ops) => {
    const h = new HubCtor(8 * 1024 * 1024)
    for (let i = 0; i < subCount; i++) {
      h.subscribe(i, i % 4 === 0 ? 'org/42/orders' : `org/${i}/other`)
    }
    let now = 1755083412345
    for (let i = 0; i < ops; i++) {
      if ((i & 63) === 0) now++
      h.publish(now, 'org/42/orders', payload)
    }
  }
}

const PAYLOAD_SM = JSON.stringify({ id: 'ord_918', total: 4200, status: 'paid', customer: 'cus_7712' })
const PAYLOAD_LG = JSON.stringify({ id: 'ord_918', items: Array.from({ length: 40 }, (_, i) => ({ sku: `sku_${i}`, qty: i, price: i * 199 })) })

const scenarios = [
  ['200B payload, 0 subscribers',    0,    PAYLOAD_SM, 300_000],
  ['200B payload, 100 subscribers',  100,  PAYLOAD_SM, 200_000],
  ['200B payload, 1000 subscribers', 1000, PAYLOAD_SM, 50_000],
  ['2KB payload, 100 subscribers',   100,  PAYLOAD_LG, 100_000],
]

console.log('publish() — encode + id assign + history append + subscriber match')
console.log('-'.repeat(78))
console.log(
  'scenario'.padEnd(34) +
  'wasm ops/s'.padStart(13) + 'js ops/s'.padStart(13) + 'ratio'.padStart(9) + 'wasm µs/op'.padStart(12)
)
console.log('-'.repeat(78))

const rows = []
for (const [label, subs, payload, ops] of scenarios) {
  const w = bench('wasm', makeRun(wasm.Hub, subs, payload), ops)
  const t = bench('ts', makeRun(TsHub, subs, payload), ops)
  rows.push({ label, w, t })
  const ratio = w.opsPerSec / t.opsPerSec
  console.log(
    label.padEnd(34) +
    fmt(w.opsPerSec).padStart(13) +
    fmt(t.opsPerSec).padStart(13) +
    (ratio >= 1 ? `${ratio.toFixed(2)}x` : `${ratio.toFixed(2)}x`).padStart(9) +
    w.usPerOp.toFixed(2).padStart(12)
  )
}

// ------------------------------------------- isolating the boundary from the logic

console.log('\nwhere the time actually goes (200B payload, 100 subscribers)')
console.log('-'.repeat(78))

const OPS = 200_000

// Rust logic with zero boundary crossings.
{
  const h = new wasm.Hub(8 * 1024 * 1024)
  for (let i = 0; i < 100; i++) h.subscribe(i, i % 4 === 0 ? 'org/42/orders' : `org/${i}/other`)
  h.bench_internal(20_000, 'org/42/orders', PAYLOAD_SM)
  const t0 = process.hrtime.bigint()
  h.bench_internal(OPS, 'org/42/orders', PAYLOAD_SM)
  const ns = Number(process.hrtime.bigint() - t0)
  const internal = (OPS / ns) * 1e9
  const endToEnd = rows[1].w.opsPerSec
  const js = rows[1].t.opsPerSec
  console.log(`rust logic only (no boundary):  ${fmt(internal).padStart(9)} ops/s`)
  console.log(`wasm as called from node:       ${fmt(endToEnd).padStart(9)} ops/s   ← ${(100 - (endToEnd / internal) * 100).toFixed(0)}% lost to marshalling`)
  console.log(`plain javascript:               ${fmt(js).padStart(9)} ops/s`)
  console.log(`\nThe Rust logic is ${(internal / js).toFixed(1)}x the JS. Marshalling gives all of it back and`)
  console.log(`then some: strings are copied into linear memory on the way in and the frame`)
  console.log(`is copied out on the way back, per publish.`)
}

// ------------------------------------------------------------------------ context

console.log('\nwhat these numbers have to clear')
console.log('-'.repeat(78))
const worst = Math.min(...rows.map((r) => r.w.opsPerSec))
const realistic = 1000   // publishes/sec for a busy single-process dashboard app
console.log(`slowest wasm scenario:        ${fmt(worst)} publishes/sec`)
console.log(`busy single-process app:      ~${fmt(realistic)} publishes/sec`)
console.log(`headroom:                     ${(worst / realistic).toFixed(0)}x`)
console.log(`\nA single Express process saturates on socket writes and JSON.stringify long`)
console.log(`before it saturates on frame encoding. Both bindings are far past the point`)
console.log(`where the hub is the bottleneck.`)

function fmt(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0)
}
