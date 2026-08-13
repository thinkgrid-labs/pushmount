// Adapts the spike's TypeScript hub to the conformance runner's expected shape.
import { Hub, encodeFrame as enc } from './hub.mjs'

export const encodeFrame = enc
export const validTopic = (t) => Hub.validTopic(t)
export const compareIds = ([msA, seqA], [msB, seqB]) =>
  msA !== msB ? Math.sign(msA - msB) : Math.sign(seqA - seqB)
export const newHub = () => new Hub(8 * 1024 * 1024)
