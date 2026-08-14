/**
 * The hub core — PROTOCOL.md §2, §3, §6, §10.
 *
 * This module owns the parts of the protocol that must be identical everywhere: id
 * assignment, topic validation, frame encoding, and the history ring. It performs no
 * IO and knows nothing about HTTP; the handler layer owns sockets.
 *
 * Per DECISIONS.md D2 this is TypeScript rather than a Rust core. That decision rests
 * entirely on `conformance/vectors.json` remaining the arbiter — when the Rust hub
 * lands in v0.3 it reads the same corpus. Do not add behaviour here that the corpus
 * does not pin down.
 */

const MAX_TOPIC_BYTES = 255
/** §6.0 — an origin is a correlation token, not a name; 64 bytes is generous for one. */
const MAX_ORIGIN_BYTES = 64
const RESERVED_PREFIX = 0x7e // '~'

const encoder = new TextEncoder()

/** An event id: §2, `<ms>-<seq>`. */
export interface EventId {
  readonly ms: number
  readonly seq: number
}

export function formatId(id: EventId): string {
  return `${id.ms}-${id.seq}`
}

/**
 * §2.1 — parse a cursor. Returns null for anything malformed, which callers must
 * surface as a 400 rather than silently treating as "no cursor": a client that
 * believes it presented a cursor and is quietly given a live-only stream has lost
 * data with nothing reported, which is the failure this protocol exists to prevent.
 */
export function parseId(raw: string): EventId | null {
  const dash = raw.indexOf('-')
  if (dash <= 0 || dash === raw.length - 1) return null
  const ms = raw.slice(0, dash)
  const seq = raw.slice(dash + 1)
  if (!isCanonicalUint(ms) || !isCanonicalUint(seq)) return null
  const msN = Number(ms)
  const seqN = Number(seq)
  if (!Number.isSafeInteger(msN) || !Number.isSafeInteger(seqN)) return null
  return { ms: msN, seq: seqN }
}

/** Rejects leading zeros, signs, whitespace and exponents — §2 says decimal, no padding. */
function isCanonicalUint(s: string): boolean {
  if (s.length === 0 || s.length > 16) return false
  if (s.length > 1 && s.charCodeAt(0) === 0x30) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x30 || c > 0x39) return false
  }
  return true
}

/** §2.1 — compare by parsed halves. Never compare ids as strings. */
export function compareIds(a: EventId, b: EventId): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1
  return 0
}

/**
 * UTF-8 byte length without allocating.
 *
 * §3 bounds a topic in bytes. Using `topic.length` counts UTF-16 code units and admits
 * topics up to three times over the limit — conformance vector T15, which is a real
 * bug this corpus caught rather than a hypothetical.
 */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** §3 — topic validation. */
export function validTopic(topic: string): boolean {
  const n = topic.length
  // UTF-8 length is always >= UTF-16 length, so this is a sound cheap reject.
  if (n === 0 || n > MAX_TOPIC_BYTES) return false
  if (topic.charCodeAt(0) === RESERVED_PREFIX) return false
  for (let i = 0; i < n; i++) {
    const c = topic.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return utf8Length(topic) <= MAX_TOPIC_BYTES
}

/**
 * §6.0 — origin validation.
 *
 * The same rule as a topic, and for the same reason: an origin reaches the wire, so a
 * value containing LF ends the frame and what follows parses as a new field. Unlike a
 * topic it arrives from whichever client issued the write, which makes it the more
 * exposed of the two.
 */
export function validOrigin(origin: string): boolean {
  const n = origin.length
  if (n === 0 || n > MAX_ORIGIN_BYTES) return false
  for (let i = 0; i < n; i++) {
    const c = origin.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return utf8Length(origin) <= MAX_ORIGIN_BYTES
}

/**
 * §6.1 — encode one data frame.
 *
 * The payload is split on every CR, LF or CRLF and each segment becomes its own
 * `data:` line. Emitting the payload raw is a forgery primitive: a payload containing
 * a blank line ends the frame and the next line parses as `event:` or `id:`. That is
 * conformance vector E2 and it is reachable from any user-supplied string.
 */
export function encodeFrame(
  ms: number,
  seq: number,
  topic: string,
  payload: string,
  origin?: string,
): Uint8Array {
  const out: string[] = [`id: ${ms}-${seq}\n`, `event: ${topic}\n`]
  // §6.0 — omitted entirely when absent, so a frame without one is byte-identical to
  // what an implementation that predates the field would produce.
  if (origin !== undefined && origin !== '') out.push(`origin: ${origin}\n`)

  let start = 0
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i)
    if (c === 13 || c === 10) {
      out.push('data: ' + payload.slice(start, i) + '\n')
      if (c === 13 && payload.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
  }
  out.push('data: ' + payload.slice(start) + '\n', '\n')

  return encoder.encode(out.join(''))
}

/** §7 — a control frame. Carries no `id:`, so it never advances a client's cursor. */
export function encodeControl(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ~${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

interface HistoryEntry {
  readonly ms: number
  readonly seq: number
  readonly topic: string
  readonly frame: Uint8Array
}

/** Shared by `publish` and `append`: validate before anything reaches the wire. */
function assertOrigin(origin: string | undefined): void {
  if (origin === undefined || origin === '') return
  if (!validOrigin(origin)) {
    throw new TypeError(`invalid origin: ${JSON.stringify(origin.slice(0, 64))}`)
  }
}

export interface HubOptions {
  /** §10 — bytes, not events. A count bound is not a memory bound. */
  maxHistoryBytes?: number
}

export class Hub {
  #lastMs = 0
  #lastSeq = 0
  #history: HistoryEntry[] = []
  #head = 0
  #bytes = 0
  readonly #maxBytes: number

  constructor(options: HubOptions = {}) {
    this.#maxBytes = options.maxHistoryBytes ?? 8 * 1024 * 1024
  }

  /**
   * §2.2 — assign the next id. Never returns an id less than or equal to the previous
   * one: if the wall clock regresses or stalls, the millisecond is reused and the
   * sequence advances. A backwards clock must never surface as a backwards cursor.
   */
  #nextId(nowMs: number): EventId {
    if (nowMs > this.#lastMs) {
      this.#lastMs = nowMs
      this.#lastSeq = 0
    } else {
      this.#lastSeq++
    }
    return { ms: this.#lastMs, seq: this.#lastSeq }
  }

  /** Encodes, assigns an id and appends to history. Fan-out is the handler's job. */
  publish(
    nowMs: number,
    topic: string,
    payload: string,
    origin?: string,
  ): { id: EventId; frame: Uint8Array } {
    if (!validTopic(topic)) {
      throw new TypeError(`invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
    }
    assertOrigin(origin)
    return this.append(this.#nextId(nowMs), topic, payload, origin)
  }

  /**
   * Appends an event whose id was assigned elsewhere.
   *
   * A backplane owns id assignment, not just transport: per-process counters collide,
   * so two pods would mint the same `<ms>-<seq>` and a client's dedupe would silently
   * discard real events. With Redis the id comes from `XADD`, which is why §2 fixed
   * that format in the first place.
   *
   * The local sequence is advanced past the supplied id so that a later fall back to
   * local assignment — a backplane outage, say — cannot mint an id that has already
   * been used.
   */
  append(
    id: EventId,
    topic: string,
    payload: string,
    origin?: string,
  ): { id: EventId; frame: Uint8Array } {
    if (!validTopic(topic)) {
      throw new TypeError(`invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
    }
    assertOrigin(origin)
    if (compareIds(id, { ms: this.#lastMs, seq: this.#lastSeq }) > 0) {
      this.#lastMs = id.ms
      this.#lastSeq = id.seq
    }
    const frame = encodeFrame(id.ms, id.seq, topic, payload, origin)

    this.#history.push({ ms: id.ms, seq: id.seq, topic, frame })
    this.#bytes += frame.length
    while (this.#bytes > this.#maxBytes && this.#head < this.#history.length) {
      this.#bytes -= this.#history[this.#head]!.frame.length
      this.#head++
    }
    if (this.#head > 1024) {
      this.#history = this.#history.slice(this.#head)
      this.#head = 0
    }

    return { id, frame }
  }

  /** §5 — the newest id assigned, or `0-0` if nothing has been published. */
  cursor(): string {
    return `${this.#lastMs}-${this.#lastSeq}`
  }

  /**
   * §4.5 steps 1 and 3 as one operation: decide the checkpoint and snapshot the
   * replay set together. Splitting these lets history trim in between, which under-
   * reports a real gap — the exact silent staleness the protocol exists to eliminate.
   */
  checkpointAndReplay(cursor: EventId | null, topics: readonly string[]): {
    truncated: boolean
    frames: Uint8Array[]
  } {
    if (cursor === null) return { truncated: false, frames: [] }

    const oldest = this.#history[this.#head]
    const truncated = oldest !== undefined && compareIds(cursor, oldest) < 0

    const frames: Uint8Array[] = []
    for (let i = this.#head; i < this.#history.length; i++) {
      const e = this.#history[i]!
      if (compareIds(e, cursor) > 0 && topics.includes(e.topic)) frames.push(e.frame)
    }
    return { truncated, frames }
  }

  get historyLength(): number {
    return this.#history.length - this.#head
  }

  get historyBytes(): number {
    return this.#bytes
  }
}
