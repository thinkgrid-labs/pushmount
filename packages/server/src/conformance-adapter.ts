// Adapts the hub core to the shape conformance/runner.mjs expects.
// Kept separate from hub.ts so the public API is not shaped by the test harness.
import {
  Hub,
  encodeFrame,
  parseId,
  validOrigin,
  validTopic,
  compareIds as cmp,
} from './hub.js'
import { Registry, type BufferVerdict } from './registry.js'

export { encodeFrame, validOrigin, validTopic }

export function compareIds(a: [number, number], b: [number, number]): number {
  return cmp({ ms: a[0], seq: a[1] }, { ms: b[0], seq: b[1] })
}

/** §2.1 — whether a string is a canonical id at all. */
export function validId(raw: string): boolean {
  return parseId(raw) !== null
}

/**
 * §8.2 — one registered subscriber on a hub capped at `maxBufferBytes`.
 *
 * Separate from `newHub` because backpressure needs a subscriber to exist and a cap to
 * be set, and folding both into the general hub would make every other group carry
 * configuration it does not use.
 */
export function newBufferHub(maxBufferBytes: number): {
  buffer(n: number): BufferVerdict
  sent(n: number): BufferVerdict
  flushed(n: number): BufferVerdict
} {
  const registry = new Registry({ maxBufferBytes })
  const added = registry.add(['t'])
  if (!added.ok) throw new Error(`could not register a subscriber: ${added.reason}`)
  return {
    buffer: (n) => registry.noteBuffer(added.id, n),
    sent: (n) => registry.noteSent(added.id, n),
    flushed: (n) => registry.noteFlushed(added.id, n),
  }
}

export function newHub(maxHistoryBytes?: number): {
  publish(nowMs: number, topic: string, payload: string, origin?: string): Uint8Array
  append(id: string, topic: string, payload: string, origin?: string): Uint8Array
  encode(id: string, topic: string, payload: string, origin?: string): Uint8Array
  cursor(): string
  checkpoint(cursor: [number, number] | null): 'absent' | 'echo' | 'earliest'
} {
  const hub = new Hub(maxHistoryBytes === undefined ? {} : { maxHistoryBytes })
  /** The corpus supplies ids as text, because §2.1's parsing rule is part of what it pins. */
  const id = (raw: string) => {
    const parsed = parseId(raw)
    if (parsed === null) throw new TypeError(`malformed id: ${raw}`)
    return parsed
  }
  return {
    publish: (nowMs, topic, payload, origin) => hub.publish(nowMs, topic, payload, origin).frame,
    append: (raw, topic, payload, origin) => hub.append(id(raw), topic, payload, origin).frame,
    encode: (raw, topic, payload, origin) => {
      // The same two checks the core makes on every path that writes a frame. Skipping
      // them here would let the adapter pass a vector the real encode path would refuse.
      const parsed = id(raw)
      if (!validTopic(topic)) throw new TypeError(`invalid topic: ${topic}`)
      if (origin !== undefined && origin !== '' && !validOrigin(origin)) {
        throw new TypeError(`invalid origin: ${origin}`)
      }
      return encodeFrame(parsed.ms, parsed.seq, topic, payload, origin)
    },
    cursor: () => hub.cursor(),
    checkpoint: (cursor) => {
      if (cursor === null) return 'absent'
      const { truncated } = hub.checkpointAndReplay({ ms: cursor[0], seq: cursor[1] }, ['t'])
      return truncated ? 'earliest' : 'echo'
    },
  }
}
