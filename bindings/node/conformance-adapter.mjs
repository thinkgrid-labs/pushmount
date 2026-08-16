// Adapts the native binding to conformance/runner.mjs.
//
// This is the point of the whole exercise: the Rust core, called from Node, must agree
// byte-for-byte with the same corpus the TypeScript hub passes.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('./dist/aghoz.node')

export const encodeFrame = (ms, seq, topic, payload, origin) =>
  new Uint8Array(native.encodeFrame(ms, seq, topic, payload, origin ?? null))

export const validTopic = (topic) => native.validateTopic(topic)

export const validOrigin = (origin) => native.validateOrigin(origin)

export const compareIds = ([msA, seqA], [msB, seqB]) =>
  native.compareIds(`${msA}-${seqA}`, `${msB}-${seqB}`)

export function newHub(maxHistoryBytes) {
  const hub = new native.Hub(maxHistoryBytes === undefined ? {} : { maxHistoryBytes })
  return {
    publish: (nowMs, topic, payload) => new Uint8Array(hub.publish(nowMs, topic, payload).frame),
    // The binding already reports the checkpoint as the same three strings the corpus
    // uses, so this asks the Rust core the identical question the TypeScript hub is asked.
    checkpoint: (cursor) =>
      hub.subscribe(['t'], undefined, cursor === null ? undefined : `${cursor[0]}-${cursor[1]}`)
        .checkpoint,
  }
}
