/**
 * Persistent history — replay that survives a restart.
 *
 * The hub's ring is in memory, so a restart loses it. With the checkpoint rule as it now
 * stands that is *safe* — a client resuming with a cursor the hub cannot vouch for is
 * told `earliest` and refetches — but it is not free: every connected client refetches at
 * once, on every deploy. A store turns that thundering herd back into an ordinary replay.
 *
 * **You probably do not need this.** A Redis backplane already is a persistent shared
 * history, so anything running more than one process is covered by
 * [`Backplane`](./backplane.ts) and should use that instead. This exists for the
 * single-process deployment that does not want Redis, which is the one case the backplane
 * leaves out.
 *
 * ## Why it is here and not in the core
 *
 * The core performs no IO, on purpose and by enforced invariant — that is what lets one
 * Rust implementation serve every language without each of them re-deriving the protocol
 * (DECISIONS.md D3). So a store cannot live there. It lives at the handler layer and
 * restores through `core.append`, which exists because a backplane needed the same thing:
 * a way to record an event whose id was assigned somewhere else.
 *
 * That is also why restoration is honest rather than clever. Events are replayed into the
 * ring exactly as they were, with their original ids, and the ring's own byte budget then
 * applies as usual — a store holding more than `maxHistoryBytes` simply has its oldest
 * entries evicted on the way in, and the eviction marks the hub's floor correctly.
 */

/** One event, as it is written down. The wire fields and nothing else. */
export interface StoredEvent {
  readonly id: string
  readonly topic: string
  readonly payload: string
  /** §6.0 — kept, because a client still has to be able to skip its own echo on replay. */
  readonly origin?: string
}

/** What a store hands back at startup. */
export interface LoadedHistory {
  /**
   * Everything to restore, **oldest first**.
   *
   * Order is load-bearing: the ring assumes its oldest entry is at the head, and
   * out-of-order restoration corrupts the eviction mark that decides whether a gap gets
   * reported. A store that cannot guarantee order should sort before returning.
   */
  readonly events: readonly StoredEvent[]
  /**
   * The newest id this store has **dropped**, if it has dropped any.
   *
   * A bounded store discards its oldest entries, and without this the hub cannot tell the
   * difference between "the store never had that event" and "the store threw it away" —
   * so it would answer "you missed nothing" to a client whose events were compacted out
   * from under it. That is the same silent staleness the checkpoint rule exists to
   * prevent, one level down, and only the store knows the answer.
   *
   * The hub treats it exactly as it treats its own ring's eviction mark: a cursor below
   * this is a gap, a cursor equal to it is not, because that is the event the client
   * already holds.
   */
  readonly trimmed?: string
  /**
   * True when the store cannot vouch that its tail is complete.
   *
   * A store may have retained a valid prefix while losing newer events in a crash or a
   * failed write. Replaying that prefix to a cursor inside it otherwise looks healthy,
   * even though events after the cursor disappeared. The handler reports a gap for every
   * resumed client in this state; a false refetch is safer than a silent hole.
   */
  readonly uncertain?: boolean
}

export interface HistoryStore {
  /**
   * Called once, at startup. A rejection is fatal to restoration but not to the hub: it
   * starts empty, which is the same state it would have had without a store, and every
   * resuming client is correctly told it missed events.
   */
  load(): Promise<LoadedHistory>

  /**
   * Records one event, after the hub has accepted it.
   *
   * Called on the publish path, so a slow implementation slows publishing. It may return
   * a promise; the hub does not await it, and routes a rejection to `onError` rather than
   * failing the publish — an event that reached subscribers has happened whether or not
   * it was also written down.
   */
  append(event: StoredEvent): void | Promise<void>

  /**
   * Flushes anything still in flight and releases the store's resources.
   *
   * `hub.close()` calls this and does **not** await it — `close()` is synchronous by
   * contract, and making shutdown async would change every caller. So for a graceful
   * shutdown that must not lose the tail of the log, hold the store and await it
   * yourself:
   *
   * ```js
   * const store = createFileStore({ path: '/var/lib/app/events.log' })
   * const hub = createHub({ history: store })
   * // …
   * hub.close()
   * await store.close()   // the writes still queued are on disk after this
   * ```
   *
   * Calling it twice must be safe, because the line above does exactly that.
   */
  close(): Promise<void>
}

/**
 * A store that keeps everything in memory. Useless in production, exact for tests.
 *
 * Shipped rather than left in the test folder because it is also the reference for what
 * an implementation has to do: preserve order, preserve `origin`, and hand back what it
 * was given.
 */
export function createMemoryStore(
  seed: readonly StoredEvent[] = [],
  trimmed?: string,
): HistoryStore & { readonly events: readonly StoredEvent[] } {
  const events: StoredEvent[] = [...seed]
  return {
    events,
    load: () => Promise.resolve({ events: [...events], ...(trimmed !== undefined && { trimmed }) }),
    append: (event) => {
      events.push(event)
    },
    close: () => Promise.resolve(),
  }
}
