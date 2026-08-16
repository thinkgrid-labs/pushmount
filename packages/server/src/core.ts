/**
 * The seam between the HTTP layer and whichever implementation of the protocol is in
 * use — the TypeScript hub, or the Rust core through its Node binding.
 *
 * The shape is the *native* one, not the TypeScript one, on purpose. `subscribe` there
 * is a single call that registers, decides the checkpoint and snapshots the replay set
 * together, because §4.5 requires those to describe one instant. An interface that
 * offered them separately would let a future caller interleave an `await` and
 * reintroduce the race — so the seam does not offer the pieces at all.
 */

export type CheckpointKind = 'absent' | 'echo' | 'earliest'
export type BufferKind = 'ok' | 'slow-consumer' | 'unknown'

export interface PublishOutcome {
  readonly id: string
  readonly frame: Uint8Array
  readonly targets: readonly number[]
}

export interface SubscribeOutcome {
  readonly id: number
  readonly checkpoint: CheckpointKind
  readonly replay: readonly Uint8Array[]
}

/**
 * Reasons the core refuses a call. The subscribe ones are mapped to status codes by the
 * handler; `invalid-origin` can only come from a publish, which is a caller error rather
 * than a request that needs a status.
 */
export type SubscribeRejection =
  | 'invalid-topic'
  | 'too-many-topics'
  | 'max-connections'
  | 'max-connections-per-key'
  | 'malformed-cursor'
  | 'invalid-origin'

export class CoreError extends Error {
  constructor(readonly reason: SubscribeRejection, message: string) {
    super(message)
    this.name = 'CoreError'
  }
}

export interface HubCore {
  publish(nowMs: number, topic: string, payload: string, origin?: string): PublishOutcome
  /**
   * Records an event whose id a backplane assigned, and returns who should get it.
   *
   * Separate from `publish` because the id must not be reassigned: two processes
   * minting their own would collide, and clients would discard real events as
   * already-seen.
   */
  append(id: string, topic: string, payload: string, origin?: string): PublishOutcome
  /**
   * Encodes a frame for an event whose id was assigned elsewhere, recording nothing.
   *
   * This is what replay from a *shared* history needs. Those events are already in the
   * shared log, and this process either recorded them when they arrived live or was not
   * running yet; either way the only thing missing is their bytes. Routing them through
   * `append` instead — which is what this used to do, for want of an encoder — pushed a
   * duplicate into the local ring on every reconnect, out of id order, which quietly
   * breaks the ring's "the oldest entry is at the head" assumption that decides whether
   * a gap gets reported.
   */
  encode(id: string, topic: string, payload: string, origin?: string): Uint8Array
  subscribe(
    topics: readonly string[],
    key: string | undefined,
    cursor: string | undefined,
  ): SubscribeOutcome
  /**
   * §8.2 — the host reports a subscriber's *absolute* queued depth.
   *
   * Correct wherever the transport can be asked how much is outstanding, which is what
   * `res.writableLength` gives Node. The handler in this package uses only this.
   */
  noteBuffer(subscriber: number, queuedBytes: number): BufferKind
  /**
   * §8.2 — the delta alternative, for a host with no absolute depth to report.
   *
   * Part of the seam even though Node never calls it, because the seam's job is to be the
   * shape every language binds to: ASGI, `net/http` and Swoole all backpressure by
   * suspending rather than by exposing a queue depth, so without this pair §8.2 is
   * unimplementable in most of the runtimes the C ABI exists for. Shares `noteBuffer`'s
   * counter and threshold; do not mix the two styles on one subscriber.
   */
  noteSent(subscriber: number, bytes: number): BufferKind
  /** §8.2 — bytes previously reported to `noteSent` have drained. */
  noteFlushed(subscriber: number, bytes: number): BufferKind
  remove(subscriber: number): boolean
  cursor(): string
  connectionCount(): number
  slowConsumerFrame(subscriber: number): Uint8Array
  truncatedFrame(subscriber: number): Uint8Array
  deniedFrame(topics: readonly string[]): Uint8Array
  /**
   * §2.1 — compare two ids, returning negative, zero or positive.
   *
   * On the seam because the handler layer genuinely needs it and must not reimplement it:
   * ids MUST NOT be compared as strings (`1755083412345-10` sorts before
   * `1755083412345-7`), and a host that got this wrong would silently discard live events
   * as already-seen. The persistent-history path is the first caller — it has to decide
   * whether a cursor predates what a store trimmed away.
   */
  compareIds(a: string, b: string): number
  validTopic(topic: string): boolean
  /** §6.0 — an origin reaches the wire, so it is validated like a topic. */
  validOrigin(origin: string): boolean
}

export interface CoreConfig {
  maxHistoryBytes?: number
  maxBufferBytes?: number
  maxConnections?: number
  maxConnectionsPerKey?: number
  maxTopicsPerConnection?: number
}
