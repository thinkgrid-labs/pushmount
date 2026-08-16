/**
 * Observability — counters for the handler layer.
 *
 * These live here, and NOT in `hub.ts` or `HubCore`, on purpose. The core is mirrored in
 * Rust behind a C ABI and pinned by `conformance/vectors.json`; a counter is not a
 * protocol rule, so putting one there would mean an ABI break and a corpus category for
 * something no wire format depends on. Everything below is observable from the socket
 * layer, which is where the interesting failures happen anyway.
 *
 * The one thing that costs: ring occupancy — how full `maxHistoryBytes` is — is core
 * state the ABI does not expose, so it is absent here. `truncated` is the metric that
 * actually matters from that region, and the handler sees it directly.
 *
 * ## Totals, not rates
 *
 * Every counter is monotonic since `createHub`, and `uptimeMs` is reported alongside so a
 * caller can derive whatever window it wants. This library never computes a rate itself:
 * any window it picked would be the wrong one for someone, and every metrics system in
 * use — Prometheus, StatsD, OpenTelemetry — already derives rates from counters and would
 * have to undo the smoothing to do it. A gauge is reported as a gauge for the same reason.
 */

/** Why a connection ended. Every close is attributed to exactly one of these. */
export type CloseReason =
  /** The client went away: tab closed, network dropped, or a normal reconnect. */
  | 'client'
  /** §8.2 — queued bytes passed `maxBufferBytes`. The lagged-subscriber count. */
  | 'slow-consumer'
  /** §4.6 — `revalidateMs` re-ran `authorize` and it no longer permits every topic. */
  | 'revalidated'
  /** `hub.disconnect()` — the application evicted it, typically on logout. */
  | 'evicted'
  /** `hub.close()`. */
  | 'hub-closed'

/**
 * Why a request never became a stream.
 *
 * Bucketed by what the caller can do about it rather than by status code, because two
 * different 400s here mean two different things to whoever is looking: a malformed topic
 * is a client bug, and a malformed cursor is a client that must be told it cannot resume.
 */
export type RejectReason =
  /** 400 — missing, malformed or invalid `topics`, or an unparseable cursor. */
  | 'bad-request'
  /** 403 — §4.3 denied every requested topic. */
  | 'unauthorized'
  /** 429 — `maxConnections` or `maxConnectionsPerKey`. */
  | 'over-capacity'
  /** 500 — `authorize` threw at connect. */
  | 'authorize-error'
  /**
   * 500 — the protocol core failed for a reason of its own.
   *
   * Kept apart from `authorize-error` because they are different faults with different
   * owners: one is the host application's callback, the other is the core underneath it —
   * a native binding that could not answer, or a bug in the handler. Neither is the
   * caller's doing, which is why neither is counted as `bad-request`.
   */
  | 'core-error'
  /** 503 — the hub was closed, or the connection went away mid-open. */
  | 'unavailable'

/**
 * A snapshot. Plain data, safe to `JSON.stringify`, and decoupled from the live counters
 * so a caller can hold one and diff against the next.
 */
export interface HubStats {
  /** Milliseconds since `createHub`. Divide counters by this for a rate. */
  readonly uptimeMs: number

  // ---- gauges ------------------------------------------------------------------
  /** Connections open right now. */
  readonly connections: number
  /**
   * Connections registered but not yet answered — inside §4.5's atomic block, waiting on
   * a backplane replay. Zero without a backplane, and steadily non-zero with one means
   * the backplane is slow enough to be worth looking at.
   */
  readonly opening: number
  /**
   * Bytes queued on subscriber sockets right now. The leading indicator for
   * `closed['slow-consumer']`: this climbs first, and drops start when it reaches
   * `maxBufferBytes`.
   */
  readonly bufferedBytes: number

  // ---- counters ----------------------------------------------------------------
  /** Streams opened. */
  readonly opened: number
  /** Streams ended, by cause. */
  readonly closed: Readonly<Record<CloseReason, number>>
  /** Requests refused before a stream existed, by cause. */
  readonly rejected: Readonly<Record<RejectReason, number>>
  /** Events published by this process, counted once accepted. */
  readonly published: number
  /**
   * Events arriving from the backplane, which includes this process's own publishes
   * coming back round — that is the path they are delivered on. Zero without a backplane.
   */
  readonly received: number
  /** Frames written to a subscriber. One publish to ten subscribers counts ten. */
  readonly delivered: number
  /** Frames written as replay on reconnect. */
  readonly replayed: number
  /** §7.2 — connections told at least one requested topic was refused. */
  readonly denied: number
  /**
   * §7.1 — connections told their cursor had fallen off the ring.
   *
   * The number to alert on. Every one of these is a client that was informed it lost
   * events, which is the condition this whole protocol exists to make visible rather than
   * silent. A non-zero rate means `maxHistoryBytes` is too small for the reconnect
   * latency your clients actually experience.
   */
  readonly truncated: number
  /** Failures, by where they happened. */
  readonly errors: {
    /** `publish()` rejected — invalid topic or origin, or a backplane write that failed. */
    readonly publish: number
    /**
     * The backplane path failed — a `replay` that threw, or an event from it that could
     * not be appended. A failed replay also forces a `truncated`, by design: a backplane
     * that cannot answer must never be reported to a client as "nothing missed".
     */
    readonly backplane: number
    /** `authorize` threw, at connect or during revalidation. */
    readonly authorize: number
    /**
     * The persistent history store failed — a `load` that rejected at startup, or a
     * write that did. A failed load leaves the hub empty, which the checkpoint rule then
     * reports honestly; a failed write means an event reached subscribers but was not
     * written down, so a restart will not replay it.
     */
    readonly history: number
    /**
     * The protocol core threw something that is not one of its rejections — a native
     * binding failing on its own terms, or a bug here.
     *
     * Distinct from the rejections beside it, which describe the *request*. A non-zero
     * count means requests are being refused for a reason no client can fix, so it is the
     * one number in this group that says "the server is broken" rather than "something
     * downstream is".
     */
    readonly core: number
  }
}

/** The live, mutable side. Internal — `hub.stats()` hands out snapshots of it. */
export interface Counters {
  readonly startedAt: number
  opened: number
  closed: Record<CloseReason, number>
  rejected: Record<RejectReason, number>
  published: number
  received: number
  delivered: number
  replayed: number
  denied: number
  truncated: number
  errors: {
    publish: number
    backplane: number
    authorize: number
    history: number
    core: number
  }
}

export function createCounters(now: () => number): Counters {
  return {
    startedAt: now(),
    opened: 0,
    closed: { client: 0, 'slow-consumer': 0, revalidated: 0, evicted: 0, 'hub-closed': 0 },
    rejected: {
      'bad-request': 0,
      unauthorized: 0,
      'over-capacity': 0,
      'authorize-error': 0,
      'core-error': 0,
      unavailable: 0,
    },
    published: 0,
    received: 0,
    delivered: 0,
    replayed: 0,
    denied: 0,
    truncated: 0,
    errors: { publish: 0, backplane: 0, authorize: 0, history: 0, core: 0 },
  }
}

/**
 * Copies the counters and computes the gauges.
 *
 * The gauges are derived by walking the connection map rather than kept as running
 * totals. A maintained gauge is a pair of increments that must never be missed on any
 * path — and `drop` alone is reachable from five of them — so it drifts, silently, in the
 * direction of looking healthier than it is. Walking is O(connections) on a call a
 * scraper makes every few seconds, which is the cheaper mistake to make.
 */
export function snapshot(
  counters: Counters,
  now: () => number,
  connections: Iterable<{ pending: unknown[] | null; res: { writableLength?: number } }>,
): HubStats {
  let connectionCount = 0
  let opening = 0
  let bufferedBytes = 0
  for (const conn of connections) {
    connectionCount++
    if (conn.pending !== null) opening++
    bufferedBytes += conn.res.writableLength ?? 0
  }

  return {
    uptimeMs: now() - counters.startedAt,
    connections: connectionCount,
    opening,
    bufferedBytes,
    opened: counters.opened,
    closed: { ...counters.closed },
    rejected: { ...counters.rejected },
    published: counters.published,
    received: counters.received,
    delivered: counters.delivered,
    replayed: counters.replayed,
    denied: counters.denied,
    truncated: counters.truncated,
    errors: { ...counters.errors },
  }
}
