// Adapts the hub core to the shape conformance/runner.mjs expects.
// Kept separate from hub.ts so the public API is not shaped by the test harness.
import { Hub, encodeFrame, validTopic, compareIds as cmp } from './hub.js'

export { encodeFrame, validTopic }

export function compareIds(a: [number, number], b: [number, number]): number {
  return cmp({ ms: a[0], seq: a[1] }, { ms: b[0], seq: b[1] })
}

export function newHub(): { publish(nowMs: number, topic: string, payload: string): Uint8Array } {
  const hub = new Hub()
  return {
    publish: (nowMs, topic, payload) => hub.publish(nowMs, topic, payload).frame,
  }
}
