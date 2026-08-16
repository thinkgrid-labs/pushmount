// Adapts the hub core to the shape conformance/runner.mjs expects.
// Kept separate from hub.ts so the public API is not shaped by the test harness.
import { Hub, encodeFrame, validOrigin, validTopic, compareIds as cmp } from './hub.js'

export { encodeFrame, validOrigin, validTopic }

export function compareIds(a: [number, number], b: [number, number]): number {
  return cmp({ ms: a[0], seq: a[1] }, { ms: b[0], seq: b[1] })
}

export function newHub(maxHistoryBytes?: number): {
  publish(nowMs: number, topic: string, payload: string): Uint8Array
  checkpoint(cursor: [number, number] | null): 'absent' | 'echo' | 'earliest'
} {
  const hub = new Hub(maxHistoryBytes === undefined ? {} : { maxHistoryBytes })
  return {
    publish: (nowMs, topic, payload) => hub.publish(nowMs, topic, payload).frame,
    checkpoint: (cursor) => {
      if (cursor === null) return 'absent'
      const { truncated } = hub.checkpointAndReplay({ ms: cursor[0], seq: cursor[1] }, ['t'])
      return truncated ? 'earliest' : 'echo'
    },
  }
}
