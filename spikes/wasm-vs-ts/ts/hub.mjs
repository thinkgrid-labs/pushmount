// Spike B — the same hot path as core-rs/src/lib.rs, in plain JavaScript.
//
// This is the honest comparison: idiomatic, reasonably optimised JS written by someone
// trying to win, not a strawman. It produces byte-identical frames; bench.mjs asserts
// that before it measures anything.

const MAX_TOPIC_BYTES = 255
const enc = new TextEncoder()

// UTF-8 byte length without allocating an intermediate buffer.
function utf8Length(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }   // surrogate pair
    else n += 3
  }
  return n
}

export class Hub {
  constructor(maxHistoryBytes) {
    this.lastMs = 0
    this.lastSeq = 0
    this.history = []          // {ms, seq, topic, frame}
    this.historyHead = 0       // avoids O(n) shift() on trim
    this.historyBytes = 0
    this.maxHistoryBytes = maxHistoryBytes
    this.subs = []
    this.targets = []
  }

  subscribe(id, topics) {
    this.subs.push({ id, topics: topics.split(',') })
  }

  // PROTOCOL.md §3
  static validTopic(topic) {
    const n = topic.length
    // UTF-8 length is always >= UTF-16 length, so this is a sound early reject.
    if (n === 0 || n > MAX_TOPIC_BYTES) return false
    if (topic.charCodeAt(0) === 0x7e) return false
    for (let i = 0; i < n; i++) {
      const c = topic.charCodeAt(i)
      if (c < 0x20 || c === 0x7f) return false
    }
    // §3 bounds the topic in BYTES. Measuring topic.length counts UTF-16 code units
    // and accepts topics up to 3x over the limit — conformance vector T15.
    return utf8Length(topic) <= MAX_TOPIC_BYTES
  }

  publish(nowMs, topic, payload) {
    if (!Hub.validTopic(topic)) return new Uint8Array(0)

    // §2.2
    if (nowMs > this.lastMs) {
      this.lastMs = nowMs
      this.lastSeq = 0
    } else {
      this.lastSeq++
    }
    const ms = this.lastMs
    const seq = this.lastSeq

    const frame = encodeFrame(ms, seq, topic, payload)

    this.targets.length = 0
    for (let i = 0; i < this.subs.length; i++) {
      const t = this.subs[i].topics
      for (let j = 0; j < t.length; j++) {
        if (t[j] === topic) { this.targets.push(this.subs[i].id); break }
      }
    }

    this.historyBytes += frame.length
    this.history.push({ ms, seq, topic, frame })
    while (this.historyBytes > this.maxHistoryBytes && this.historyHead < this.history.length) {
      this.historyBytes -= this.history[this.historyHead].frame.length
      this.historyHead++
    }
    if (this.historyHead > 1024) {
      this.history = this.history.slice(this.historyHead)
      this.historyHead = 0
    }

    return frame
  }

  targetCount() { return this.targets.length }

  replay(cursorMs, cursorSeq, topics) {
    const want = topics.split(',')
    const parts = []
    let total = 0
    for (let i = this.historyHead; i < this.history.length; i++) {
      const e = this.history[i]
      if (e.ms > cursorMs || (e.ms === cursorMs && e.seq > cursorSeq)) {
        if (want.includes(e.topic)) { parts.push(e.frame); total += e.frame.length }
      }
    }
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) { out.set(p, o); o += p.length }
    return out
  }

  truncated(cursorMs, cursorSeq) {
    if (this.historyHead >= this.history.length) return false
    const o = this.history[this.historyHead]
    return cursorMs < o.ms || (cursorMs === o.ms && cursorSeq < o.seq)
  }

  historyLen() { return this.history.length - this.historyHead }
}

// §6.1
export function encodeFrame(ms, seq, topic, payload) {
  const lines = []
  lines.push(`id: ${ms}-${seq}\n`)
  lines.push(`event: ${topic}\n`)

  let start = 0
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i)
    if (c === 13 || c === 10) {
      lines.push('data: ' + payload.slice(start, i) + '\n')
      if (c === 13 && payload.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
  }
  lines.push('data: ' + payload.slice(start) + '\n')
  lines.push('\n')

  return enc.encode(lines.join(''))
}
