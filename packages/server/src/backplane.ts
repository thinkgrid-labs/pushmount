/**
 * The backplane — what makes a publish in one process reach subscribers in another.
 *
 * Two things about this interface are load-bearing and easy to get wrong.
 *
 * **It owns id assignment, not just transport.** Per-process counters collide: two pods
 * publishing in the same millisecond would both mint `1786638308197-0`, and every
 * client's dedupe would silently discard one of them as already-seen. So `publish`
 * returns the id rather than accepting one. §2 fixed the `<ms>-<seq>` format precisely
 * so a shared sequencer could issue it.
 *
 * **Every event travels through it, including the publishing process's own.** The
 * alternative — deliver locally and also broadcast — gives each process a different
 * ordering, and makes a subscriber's view depend on which pod it happened to land on.
 * One path costs a round trip before your own subscribers see the event, and buys an
 * ordering that is identical everywhere.
 */

export interface BackplaneEvent {
  readonly id: string
  readonly topic: string
  readonly payload: string
  /**
   * §6.0 — carried across processes, because the tab that issued the write may be
   * connected to a different one than the tab's write landed on. An origin that only
   * survived locally would dedupe on one pod and duplicate on every other.
   */
  readonly origin?: string
}

export interface BackplaneReplay {
  /** True when the cursor is older than the shared history reaches. */
  readonly truncated: boolean
  readonly events: readonly BackplaneEvent[]
}

export interface Backplane {
  /** Records the event and returns the id assigned to it. */
  publish(topic: string, payload: string, origin?: string): Promise<string>

  /**
   * Registers the sink that receives every event from every process, in id order.
   * Called once, when the hub is created.
   */
  onEvent(sink: (event: BackplaneEvent) => void): void

  /** Shared history after `cursor`, for a client that may have reconnected elsewhere. */
  replay(cursor: string, topics: readonly string[]): Promise<BackplaneReplay>

  /** §5 — the newest id assigned across all processes. */
  cursor(): Promise<string>

  close(): Promise<void>
}

/**
 * The default: a backplane that isn't one.
 *
 * Keeps a single process behaving exactly as it did before backplanes existed — the
 * hub assigns ids and replays from its own history — so the option costs nothing when
 * unused. `createHub` treats "no backplane" as a distinct case rather than routing
 * through this, which is why it has no publish path at all.
 */
export const NO_BACKPLANE = undefined
