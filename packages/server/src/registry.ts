/**
 * The subscriber registry — PROTOCOL.md §4.5, §8.2, §9.3, §10.
 *
 * Pure bookkeeping. The registry knows which subscriber wants which topic and how far
 * behind each one is; it never touches a socket. The handler owns responses and reports
 * their buffer depth back here, so there is exactly one place that decides whether a
 * subscriber has fallen too far behind to keep.
 */

export interface RegistryOptions {
  /** §8.2 — queued bytes past which a subscriber is disconnected, not starved. */
  maxBufferBytes?: number
  /** §10 — per process. Unlimited by default, but the limit must exist. */
  maxConnections?: number
  /** §10 — per key, typically a user id. */
  maxConnectionsPerKey?: number
  /** §9.3 — bounds the encoded query string as well as the replay scan. */
  maxTopicsPerConnection?: number
}

export type AddResult =
  | { ok: true; id: number }
  | { ok: false; reason: 'max-connections' | 'max-connections-per-key' | 'too-many-topics' }

interface Subscriber {
  readonly id: number
  readonly topics: readonly string[]
  readonly key: string | undefined
  queued: number
}

export class Registry {
  /**
   * Never recycled. A recycled id lets a write scheduled for a closed subscriber land
   * on whoever inherited the number, which is a cross-tenant leak that would be very
   * hard to reproduce.
   */
  #nextId = 1

  readonly #subs = new Map<number, Subscriber>()
  /** §4.5 — topic index, so a publish costs O(matching) rather than O(subscribers). */
  readonly #byTopic = new Map<string, Set<number>>()
  readonly #byKey = new Map<string, number>()

  readonly #maxBufferBytes: number
  readonly #maxConnections: number
  readonly #maxPerKey: number
  readonly #maxTopics: number

  constructor(options: RegistryOptions = {}) {
    this.#maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024
    this.#maxConnections = options.maxConnections ?? Number.POSITIVE_INFINITY
    this.#maxPerKey = options.maxConnectionsPerKey ?? Number.POSITIVE_INFINITY
    this.#maxTopics = options.maxTopicsPerConnection ?? 64
  }

  add(topics: readonly string[], key?: string): AddResult {
    if (topics.length === 0 || topics.length > this.#maxTopics) {
      return { ok: false, reason: 'too-many-topics' }
    }
    if (this.#subs.size >= this.#maxConnections) {
      return { ok: false, reason: 'max-connections' }
    }
    if (key !== undefined && (this.#byKey.get(key) ?? 0) >= this.#maxPerKey) {
      return { ok: false, reason: 'max-connections-per-key' }
    }

    const id = this.#nextId++
    // Duplicate topics in one subscription would otherwise deliver an event twice to
    // the same socket, which no client-side dedupe can help with — the ids match.
    const unique = [...new Set(topics)]
    this.#subs.set(id, { id, topics: unique, key, queued: 0 })

    for (const topic of unique) {
      let set = this.#byTopic.get(topic)
      if (set === undefined) {
        set = new Set()
        this.#byTopic.set(topic, set)
      }
      set.add(id)
    }
    if (key !== undefined) this.#byKey.set(key, (this.#byKey.get(key) ?? 0) + 1)

    return { ok: true, id }
  }

  /**
   * Idempotent by design. §8.2 requires removal on both the request's and the
   * response's close event, and those both fire in the ordinary case.
   */
  remove(id: number): boolean {
    const sub = this.#subs.get(id)
    if (sub === undefined) return false
    this.#subs.delete(id)

    for (const topic of sub.topics) {
      const set = this.#byTopic.get(topic)
      if (set === undefined) continue
      set.delete(id)
      // Without this the map grows forever on a workload with per-entity topics.
      if (set.size === 0) this.#byTopic.delete(topic)
    }

    if (sub.key !== undefined) {
      const n = (this.#byKey.get(sub.key) ?? 1) - 1
      if (n <= 0) this.#byKey.delete(sub.key)
      else this.#byKey.set(sub.key, n)
    }
    return true
  }

  /** Subscriber ids wanting this topic. Empty array when none — never null. */
  match(topic: string): readonly number[] {
    const set = this.#byTopic.get(topic)
    return set === undefined ? EMPTY : [...set]
  }

  /**
   * §8.2 — the handler reports the socket's current queued byte count (Node's
   * `res.writableLength`) after each write, and the registry decides.
   *
   * Reporting the absolute depth rather than deltas is deliberate: the socket is the
   * only thing that actually knows how much is outstanding, and add/subtract
   * accounting drifts the moment a write is partially flushed.
   */
  noteBuffer(id: number, queuedBytes: number): 'ok' | 'slow-consumer' | 'unknown' {
    const sub = this.#subs.get(id)
    if (sub === undefined) return 'unknown'
    sub.queued = queuedBytes
    return queuedBytes > this.#maxBufferBytes ? 'slow-consumer' : 'ok'
  }

  topicsOf(id: number): readonly string[] {
    return this.#subs.get(id)?.topics ?? EMPTY_STR
  }

  get size(): number {
    return this.#subs.size
  }

  countForKey(key: string): number {
    return this.#byKey.get(key) ?? 0
  }

  /** Distinct topics currently subscribed. Diagnostics only. */
  get topicCount(): number {
    return this.#byTopic.size
  }
}

const EMPTY: readonly number[] = Object.freeze([])
const EMPTY_STR: readonly string[] = Object.freeze([])
