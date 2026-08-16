// Runs the HTTP conformance corpus against any adapter, over real HTTP.
//
//   node runner.mjs "<command that boots the adapter's test app>"
//   node runner.mjs "node adapters/node/app.mjs"
//   node runner.mjs "python -m aghoz_conformance.app"      (one day)
//
// The harness never links anything. It spawns a process, reads a port off stdout and
// speaks HTTP — which is the only thing every language has in common, and the reason this
// suite can hold a Python or Go adapter to the same contract as the Node one.
//
// Exits non-zero on any divergence.

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const command = process.argv[2]
if (!command) {
  console.error('usage: node runner.mjs "<command that boots the adapter test app>"')
  process.exit(2)
}

const corpus = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'))
const groups = Object.entries(corpus).filter(([, v]) => Array.isArray(v))

// ---------------------------------------------------------------- the test app

/** Spawns the adapter's app and waits for its `listening <port>` line. */
async function boot() {
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', (b) => stderr.push(b.toString()))

  const port = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`app did not report a port within 10s\n${stderr.join('')}`)),
      10_000,
    )
    child.stdout.on('data', (b) => {
      buffer += b.toString()
      const match = buffer.match(/listening (\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`app exited with ${code} before listening\n${stderr.join('')}`))
    })
  })

  return { child, base: `http://127.0.0.1:${port}`, stderr }
}

// ------------------------------------------------------------------- streaming

/**
 * A stream opened by a scenario, with its frames buffered as they arrive.
 *
 * Frames are consumed as they are asserted, so `expect-frames` means "the next frames",
 * and a scenario that asserts nothing about a frame leaves it for the next assertion
 * rather than silently discarding it.
 */
class Stream {
  /** Consumable: `expect-frames` takes from the front, so assertions read in order. */
  #frames = []
  /**
   * Everything this stream ever received, never consumed.
   *
   * Assertions about the *whole* stream — "exactly one frame matched", "no control frame
   * carried an id" — must read this rather than the consumable buffer. Reading the buffer
   * makes them pass vacuously the moment an earlier step has drained it, which is a
   * conformance harness that reports success for work it did not do.
   */
  #all = []
  #buffer = ''
  #done = false
  #reader = null

  constructor(res, controller) {
    this.res = res
    this.controller = controller
    if (res.body !== null) {
      this.#reader = res.body.getReader()
      void this.#pump()
    }
  }

  async #pump() {
    const dec = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.#reader.read()
        if (done) break
        this.#buffer += dec.decode(value, { stream: true })
        let i
        while ((i = this.#buffer.indexOf('\n\n')) !== -1) {
          const frame = this.#buffer.slice(0, i + 2)
          this.#frames.push(frame)
          this.#all.push(frame)
          this.#buffer = this.#buffer.slice(i + 2)
        }
      }
    } catch {
      // An aborted stream is a normal end here, not a failure.
    }
    this.#done = true
  }

  /** Waits until at least `n` frames are buffered, or the deadline passes. */
  async settle(n, ms = 2000) {
    const deadline = Date.now() + ms
    while (this.#frames.length < n && !this.#done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    return this.#frames
  }

  take(n) {
    return this.#frames.splice(0, n)
  }

  get buffered() {
    return this.#frames
  }

  /** Every frame received, including ones already consumed by an assertion. */
  get all() {
    return this.#all
  }

  abort() {
    try {
      this.controller.abort()
    } catch {
      // Already gone.
    }
  }
}

// ------------------------------------------------------------------- assertions

class Divergence extends Error {}

function fail(message, expected, actual) {
  const e = new Divergence(message)
  e.expected = expected
  e.actual = actual
  throw e
}

function checkHeaders(res, expected = {}, absent = []) {
  for (const [name, want] of Object.entries(expected)) {
    const got = res.headers.get(name)
    if (got !== want) fail(`header ${name}`, want, got)
  }
  for (const name of absent) {
    const got = res.headers.get(name)
    if (got !== null) fail(`header ${name} must be absent`, null, got)
  }
}

// ------------------------------------------------------------------ the scenario

async function runScenario(base, scenario) {
  await post(base, '/_t/reset', scenario.app ?? {})
  const streams = new Map()
  const pending = new Map()

  try {
    for (const step of scenario.steps) {
      await runStep(base, step, streams, pending)
    }
  } finally {
    for (const s of streams.values()) s.abort()
    for (const p of pending.values()) p.catch?.(() => {})
  }
}

async function runStep(base, step, streams, pending) {
  const stream = (name) => {
    const s = streams.get(name)
    if (s === undefined) throw new Divergence(`no stream named ${name} — check the scenario`)
    return s
  }

  switch (step.op) {
    // A plain request whose body is not a stream. Read and discard, so nothing is left
    // half-open to interfere with a later step.
    case 'request': {
      const res = await fetch(base + step.path, { headers: step.headers ?? {} })
      const expect = step.expect ?? {}
      if (expect.status !== undefined && res.status !== expect.status) {
        fail(`status for ${step.path}`, expect.status, res.status)
      }
      checkHeaders(res, expect.headers, expect.absentHeaders)
      await res.body?.cancel().catch(() => {})
      return
    }

    // Opens a stream and keeps it. `await: false` leaves the response pending, which is
    // how a scenario aims at the window inside the atomic block.
    case 'open': {
      const controller = new AbortController()
      const promise = fetch(base + step.path, {
        headers: step.headers ?? {},
        signal: controller.signal,
      })
      if (step.await === false) {
        pending.set(step.as, { promise, controller, expect: step.expect })
        return
      }
      const res = await promise
      const expect = step.expect ?? {}
      if (expect.status !== undefined && res.status !== expect.status) {
        fail(`status for ${step.path}`, expect.status, res.status)
      }
      checkHeaders(res, expect.headers, expect.absentHeaders)
      streams.set(step.as, new Stream(res, controller))
      return
    }

    case 'await-open': {
      const p = pending.get(step.of)
      if (p === undefined) throw new Divergence(`no pending open named ${step.of}`)
      pending.delete(step.of)
      const res = await p.promise
      const expect = step.expect ?? {}
      if (expect.status !== undefined && res.status !== expect.status) {
        fail('status', expect.status, res.status)
      }
      checkHeaders(res, expect.headers, expect.absentHeaders)
      streams.set(step.of, new Stream(res, p.controller))
      return
    }

    case 'expect-headers': {
      const s = stream(step.of)
      checkHeaders(s.res, step.headers, step.absentHeaders)
      return
    }

    // The next N frames, exactly. An empty list asserts that nothing arrived.
    case 'expect-frames': {
      const s = stream(step.of)
      if (step.frames.length === 0) {
        // Give a wrong implementation time to be wrong, rather than passing on speed.
        await new Promise((r) => setTimeout(r, 250))
        if (s.buffered.length > 0) fail('expected no frames', [], s.buffered)
        return
      }
      await s.settle(step.frames.length)
      const got = s.take(step.frames.length)
      if (JSON.stringify(got) !== JSON.stringify(step.frames)) {
        fail('frames', step.frames, got)
      }
      return
    }

    case 'expect-frame-matching': {
      const s = stream(step.of)
      const deadline = Date.now() + 2000
      for (;;) {
        const i = s.buffered.findIndex((f) => f.includes(step.contains))
        if (i !== -1) {
          s.take(i + 1)
          return
        }
        if (Date.now() > deadline) fail(`a frame containing ${JSON.stringify(step.contains)}`, step.contains, s.buffered)
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    case 'expect-frame-count': {
      const s = stream(step.of)
      // Wait out any duplicate that a broken implementation would send late.
      await new Promise((r) => setTimeout(r, 250))
      // Over everything received, not the consumable buffer: "delivered exactly once" is
      // a claim about the whole stream, and an earlier assertion may have taken the frame.
      const n = s.all.filter((f) => f.includes(step.matching)).length
      if (n !== step.count) fail(`frames matching ${JSON.stringify(step.matching)}`, step.count, n)
      return
    }

    // §7 — control frames carry no id, so they cannot advance a client's cursor.
    case 'expect-no-id-field': {
      const s = stream(step.of)
      const offenders = s.all.filter(
        (f) => (f.startsWith('event: ~') || f.startsWith(':')) && f.includes('id: '),
      )
      if (offenders.length === 0 && s.all.every((f) => !f.startsWith('event: ~') && !f.startsWith(':'))) {
        // Nothing to judge. A scenario asserting this must have produced a control frame,
        // or it is testing nothing and would pass against any implementation at all.
        fail('no control frame was received, so this assertion is vacuous', 'a control frame', s.all)
      }
      if (offenders.length > 0) {
        fail('control frames must carry no id', [], offenders)
      }
      return
    }

    case 'publish': {
      const payload = { topic: step.topic, payload: step.payload }
      if (step.origin !== undefined) payload.origin = step.origin
      await post(base, '/_t/publish', payload)
      return
    }

    case 'get-cursor': {
      const res = await fetch(`${base}/events/cursor`)
      const { cursor } = await res.json()
      if (cursor !== step.expect) fail('cursor', step.expect, cursor)
      return
    }

    case 'disconnect':
      await post(base, '/_t/disconnect', { key: step.key })
      return

    // Works on a pending open too — aborting *during* the atomic block is exactly what
    // the window scenarios are aiming at, and that connection has no response yet.
    case 'abort': {
      const p = pending.get(step.of)
      if (p !== undefined) {
        pending.delete(step.of)
        p.controller.abort()
        p.promise.catch(() => {})
        return
      }
      stream(step.of).abort()
      return
    }

    case 'sleep':
      await new Promise((r) => setTimeout(r, step.ms))
      return

    case 'expect-stats': {
      const stats = await post(base, '/_t/stats', {})
      if (step.connections !== undefined && stats.connections !== step.connections) {
        fail('stats.connections', step.connections, stats.connections)
      }
      for (const bucket of ['closed', 'rejected']) {
        if (step[bucket] === undefined) continue
        for (const [reason, want] of Object.entries(step[bucket])) {
          const got = stats[bucket]?.[reason] ?? 0
          if (got !== want) fail(`stats.${bucket}.${reason}`, want, got)
        }
      }
      return
    }

    default:
      throw new Divergence(`unknown op: ${step.op}`)
  }
}

async function post(base, path, payload) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const parsed = await res.json()
  if (!res.ok) {
    // A control-surface failure means the adapter's test app is broken, which is a
    // different problem from the adapter failing a scenario.
    throw new Error(`control endpoint ${path} failed: ${parsed.error ?? res.status}`)
  }
  return parsed
}

// ------------------------------------------------------------------------ main

const app = await boot()
let pass = 0
const failures = []

try {
  for (const [group, scenarios] of groups) {
    for (const scenario of scenarios) {
      try {
        await runScenario(app.base, scenario)
        pass++
      } catch (error) {
        failures.push({ group, scenario, error })
      }
    }
  }
} finally {
  app.child.kill()
}

const total = pass + failures.length
if (failures.length === 0) {
  console.log(`http conformance: ${total}/${total} scenarios pass — ${command}`)
  process.exit(0)
}

console.error(`http conformance: ${pass}/${total} pass, ${failures.length} FAIL — ${command}\n`)
for (const { scenario, error } of failures) {
  console.error(`  ${scenario.id}  ${scenario.desc}`)
  console.error(`      ${error.message}`)
  if (error instanceof Divergence && error.expected !== undefined) {
    console.error(`      expected: ${JSON.stringify(error.expected)}`)
    console.error(`      actual:   ${JSON.stringify(error.actual)}`)
  }
  console.error('')
}
if (app.stderr.length > 0) console.error(`app stderr:\n${app.stderr.join('')}`)
process.exit(1)
