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

/** Reasons a subscription is refused, mapped to status codes by the handler. */
export type SubscribeRejection =
  | 'invalid-topic'
  | 'too-many-topics'
  | 'max-connections'
  | 'max-connections-per-key'
  | 'malformed-cursor'

export class CoreError extends Error {
  constructor(readonly reason: SubscribeRejection, message: string) {
    super(message)
    this.name = 'CoreError'
  }
}

export interface HubCore {
  publish(nowMs: number, topic: string, payload: string): PublishOutcome
  /**
   * Records an event whose id a backplane assigned, and returns who should get it.
   *
   * Separate from `publish` because the id must not be reassigned: two processes
   * minting their own would collide, and clients would discard real events as
   * already-seen.
   */
  append(id: string, topic: string, payload: string): PublishOutcome
  subscribe(
    topics: readonly string[],
    key: string | undefined,
    cursor: string | undefined,
  ): SubscribeOutcome
  noteBuffer(subscriber: number, queuedBytes: number): BufferKind
  remove(subscriber: number): boolean
  cursor(): string
  connectionCount(): number
  slowConsumerFrame(subscriber: number): Uint8Array
  truncatedFrame(subscriber: number): Uint8Array
  deniedFrame(topics: readonly string[]): Uint8Array
  validTopic(topic: string): boolean
}

export interface CoreConfig {
  maxHistoryBytes?: number
  maxBufferBytes?: number
  maxConnections?: number
  maxConnectionsPerKey?: number
  maxTopicsPerConnection?: number
}
