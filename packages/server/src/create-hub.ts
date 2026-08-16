/**
 * The HTTP layer — PROTOCOL.md §4, §5, §7, §8.
 *
 * Everything that touches a socket lives here. `hub.ts` and `registry.ts` stay pure so
 * the conformance corpus can own them; this module owns ordering, headers and teardown,
 * which are the parts that only fail in production.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CoreError, type HubCore } from './core.js'
import { createTsCore } from './core-ts.js'
import type { Backplane } from './backplane.js'
import type { HistoryStore } from './history.js'
import {
  createCounters,
  snapshot,
  type CloseReason,
  type HubStats,
  type RejectReason,
} from './stats.js'

const encoder = new TextEncoder()
const FRAME_OK = encoder.encode(':ok\n\n')
const FRAME_KEEPALIVE = encoder.encode(':ka\n\n')

export interface CreateHubOptions {
  /** §10 — bytes, not events. */
  maxHistoryBytes?: number
  /** §8.2 — queued bytes past which a subscriber is disconnected. */
  maxBufferBytes?: number
  /** §10 — per process. */
  maxConnections?: number
  /** §10 — per key, e.g. per user. */
  maxConnectionsPerKey?: number
  /** §9.3 */
  maxTopicsPerConnection?: number
  /** §6.2 — default 20s, below typical 30–60s proxy idle timeouts. */
  keepAliveMs?: number
  /** Injectable clock. Tests need determinism; production wants Date.now. */
  now?: () => number
  /**
   * Publish failures land here rather than as an unhandled rejection, so callers may
   * treat `publish()` as fire-and-forget without a floating-promise hazard.
   */
  onError?: (error: unknown) => void
  /**
   * Silences the startup warning emitted when this process looks like one of several.
   *
   * Set it only once a backplane makes multi-process correct — or if you have read the
   * warning and accept that publishes will not cross process boundaries.
   */
  suppressClusterWarning?: boolean
  /**
   * The protocol implementation to run on.
   *
   * Defaults to the zero-dependency TypeScript core. Supplying the Rust core through
   * its Node binding swaps the implementation without changing anything below — which
   * is exactly what makes this whole test suite the core's acceptance suite.
   */
  core?: HubCore
  /**
   * Makes a publish in this process reach subscribers in every other one.
   *
   * Without it the hub is single-process only, and a publish silently reaches a
   * fraction of your subscribers — which is why `createHub` warns at startup when it
   * can tell it is one worker of several.
   */
  backplane?: Backplane
  /**
   * Makes replay survive a restart.
   *
   * Without one, a restarted hub cannot vouch for a resuming client's cursor and honestly
   * says so — the client is told `earliest` and refetches. Correct, but it means every
   * connected client refetches at once on every deploy.
   *
   * Mutually exclusive with `backplane`, which already is a persistent shared history.
   */
  history?: HistoryStore
}

/**
 * Detects the common multi-process supervisors without importing anything.
 *
 * `NODE_UNIQUE_ID` is set by `node:cluster` in workers; `pm_id` and `NODE_APP_INSTANCE`
 * by pm2. Environment sniffing is crude, but the alternative is a failure mode with no
 * symptom at all: a publish in one worker simply never reaches subscribers in another,
 * nothing errors, and it looks exactly like an application bug.
 */
function detectCluster(): string | null {
  const env = process.env
  if (env['NODE_UNIQUE_ID'] !== undefined && env['NODE_UNIQUE_ID'] !== '') return 'node:cluster'
  if (env['pm_id'] !== undefined && env['pm_id'] !== '') return 'pm2'
  if (env['NODE_APP_INSTANCE'] !== undefined && env['NODE_APP_INSTANCE'] !== '') return 'pm2'
  const concurrency = Number(env['WEB_CONCURRENCY'])
  if (Number.isFinite(concurrency) && concurrency > 1) return 'WEB_CONCURRENCY'
  return null
}

export interface HandlerOptions<Req> {
  /**
   * §4.3 — called once per requested topic, after the host application's own
   * middleware has run, so `req` already carries whatever principal it established.
   * Returning false denies that topic; the connection still opens if any topic is
   * allowed, and the client is told which were refused.
   */
  authorize?: (req: Req, topic: string) => boolean | Promise<boolean>
  /** §10 — groups connections for the per-key cap, typically by user id. */
  connectionKey?: (req: Req) => string | undefined
  /**
   * Extracts the underlying Node request from a framework's request object.
   *
   * Two different things are needed from a request, and only Express happens to
   * provide both on one object. Socket options and close events need the real
   * `IncomingMessage`; `authorize` needs whatever the framework decorated — Fastify
   * puts `request.user` on its own wrapper and the raw request never sees it. Passing
   * the raw request to `authorize` would silently hand every callback an object with
   * no user on it, and `authorize` would deny everything (or, worse, allow it).
   *
   * Defaults to identity, which is correct for Express and plain `node:http`.
   */
  toNodeRequest?: (req: Req) => IncomingMessage
  /**
   * Re-runs `authorize` on live connections every this many milliseconds. Default 0 —
   * off.
   *
   * §4.3's authorization runs once, at connect, and a stream then outlives the decision
   * that permitted it: the polling this library replaces re-authorized on every request,
   * and a long-lived stream does not. That is the largest hole in the headline claim,
   * and this is the pull-shaped half of the answer — `hub.disconnect()` is the push-
   * shaped half, for the logout and permission-change paths you control.
   *
   * A connection that loses any of its topics is closed rather than narrowed. The client
   * reconnects with its cursor and §4.3 runs again, which returns 403 if everything is
   * now denied and 200 plus a `~denied` frame if only some of it is — so the client
   * learns exactly what it lost, through paths that already exist, and nothing new
   * appears on the wire. The cost is one reconnect for a connection that kept most of
   * its topics; revocation is rare enough for that to be the right trade.
   *
   * An `authorize` that throws during revalidation drops the connection. At connect a
   * throw is a 500, because no stream exists yet; here one does, and its authorization
   * is unknown — the only safe reading of unknown is no.
   */
  revalidateMs?: number
}

export interface PublishOptions {
  /**
   * §6.0 — the id of the client that caused this event, echoed on the frame so that
   * client can skip it.
   *
   * The tab that issues a write sees the result twice: in the write's own response, and
   * again over the stream. Pass through whatever the writing client sent you — a header
   * on the mutation, usually — and `@aghoz/client` drops its own echo.
   *
   * Opaque and unauthenticated. It says which connection to skip, nothing more; never
   * read it as an identity.
   */
  origin?: string
}

export interface PublishAck {
  readonly id: string
  /** Subscribers the frame was written to. Not a delivery guarantee. */
  readonly delivered: number
}

interface Connection {
  readonly id: number
  /**
   * Frames that arrived before this connection finished opening.
   *
   * With a backplane, replay is fetched over the network, so the handler must await
   * inside what §4.5 calls the atomic block. The subscriber is registered *before* that
   * await — otherwise events published during it are lost — which means a live frame
   * can arrive before `writeHead`. Queuing it here and flushing after replay keeps the
   * response well-formed; the client dedupes any overlap by id, which is the same trade
   * §4.5 already makes locally, extended across the network.
   */
  pending: Uint8Array[] | null
  /** Owns the socket and the close events. */
  readonly nodeReq: IncomingMessage
  /** What the framework decorated — what `disconnect` predicates inspect. */
  readonly appReq: unknown
  readonly res: ServerResponse
  readonly topics: readonly string[]
  /**
   * Which `handler()` opened this connection.
   *
   * One hub can be mounted more than once — a public feed and an admin feed, say — with
   * a different `authorize` on each. Revalidation must only ever re-run the authorizer
   * that admitted a given connection, so each handler marks its own.
   */
  readonly owner: symbol
}

export function createHub(options: CreateHubOptions = {}) {
  const core =
    options.core ??
    createTsCore({
      ...(options.maxHistoryBytes !== undefined && { maxHistoryBytes: options.maxHistoryBytes }),
      ...(options.maxBufferBytes !== undefined && { maxBufferBytes: options.maxBufferBytes }),
      ...(options.maxConnections !== undefined && { maxConnections: options.maxConnections }),
      ...(options.maxConnectionsPerKey !== undefined && {
        maxConnectionsPerKey: options.maxConnectionsPerKey,
      }),
      ...(options.maxTopicsPerConnection !== undefined && {
        maxTopicsPerConnection: options.maxTopicsPerConnection,
      }),
    })

  const now = options.now ?? Date.now
  const keepAliveMs = options.keepAliveMs ?? 20_000
  const onError = options.onError ?? (() => {})
  const connections = new Map<number, Connection>()
  /** Revalidation intervals, one per handler that asked for one. Cleared by `close`. */
  const timers = new Set<NodeJS.Timeout>()
  const counters = createCounters(now)
  let closed = false

  /**
   * Refuses a request and records why, in one place.
   *
   * The reason is derived from the status rather than passed alongside it, because the
   * two travelling separately is how a bucket ends up mislabelled — and a mislabelled
   * rejection metric is worse than none, since it sends whoever reads it after the wrong
   * cause entirely.
   */
  function reject(
    res: ServerResponse,
    status: number,
    message: string,
    extra: Record<string, string> = {},
  ): void {
    counters.rejected[rejectReasonFor(status, message)]++
    fail(res, status, message, extra)
  }

  if (options.suppressClusterWarning !== true) {
    const supervisor = detectCluster()
    if (supervisor !== null) {
      console.warn(
        `\n[aghoz] This process looks like one of several (${supervisor}), and the hub ` +
          `is in-memory.\n` +
          `           A publish here reaches only THIS process's subscribers. Clients ` +
          `connected to\n` +
          `           another worker will silently never receive it — nothing will error.\n` +
          `           Run a single process until a backplane ships, or set ` +
          `suppressClusterWarning.\n`,
      )
    }
  }

  const store = options.history
  if (store !== undefined && options.backplane !== undefined) {
    // Both would record every event, and the backplane's copy is the one replay reads —
    // so the store would be written to forever and never read, which looks like durability
    // and is not. A Redis stream already is a persistent shared history.
    throw new TypeError(
      'aghoz: `history` and `backplane` are mutually exclusive — a backplane is already a persistent shared history',
    )
  }

  /**
   * Resolves once the ring has been restored. Awaited by the handler, so forgetting
   * `hub.ready()` costs a microtask rather than correctness: a request served before
   * restoration finished would see an empty hub and report a gap to a client that had
   * missed nothing.
   */
  /**
   * The newest id a store reports having dropped, if any.
   *
   * Kept here rather than pushed into the core because it is not a protocol rule — it is
   * one host's knowledge of what its own storage threw away. The core's ring has its own
   * eviction mark and knows nothing of a file that was compacted before boot.
   */
  let historyFloor: string | undefined

  /**
   * The newest id the shared log held when this process joined it — `0-0` without a
   * backplane, where the core's own sequence is the whole story.
   *
   * §5's cursor is a claim about the sequence, and with a backplane the sequence is
   * shared: a worker that has just booted has an empty ring and has read nothing, so
   * `core.cursor()` is `0-0` while the log it just joined holds everything published
   * before it started. Handing that to a page as its cold-start cursor asks the stream
   * for the entire retained history and is answered with `~gap` — a refetch, and a
   * `~gap` callback, on every page a freshly started worker serves.
   *
   * A cursor behind the sequence costs replay; one ahead of it costs events. This can
   * only ever be behind — every id it holds came out of the shared log — and seeding it
   * at boot bounds "behind" by the reader's round trip rather than by how long ago this
   * process started.
   */
  let joinedAt = '0-0'

  const backplane = options.backplane

  const restored: Promise<void> =
    store === undefined
      ? Promise.resolve()
      : store
          .load()
          .then(({ events, trimmed }) => {
            historyFloor = trimmed
            for (const event of events) {
              // Their original ids, in their original order. `append` advances the
              // sequence past each, so a later local publish cannot reissue one, and the
              // ring's own byte budget evicts the oldest exactly as it would have live.
              core.append(event.id, event.topic, event.payload, event.origin)
              counters.received++
            }
          })
          .catch((error) => {
            counters.errors.history++
            onError(error)
            // Deliberately not rethrown. A hub that starts empty is the state it would
            // have been in with no store at all, and the checkpoint rule then tells every
            // resuming client the truth. Refusing to boot would be worse.
          })

  const joined: Promise<void> =
    backplane === undefined
      ? Promise.resolve()
      : backplane
          .cursor()
          // `compareIds` rather than an assignment: it rejects an id the backplane had no
          // business returning, and it keeps this to advancing only — the same rule the
          // ring's own eviction mark follows, for the same reason.
          .then((id) => {
            if (core.compareIds(id, joinedAt) > 0) joinedAt = id
          })
          .catch((error) => {
            counters.errors.backplane++
            onError(error)
            // Not rethrown, for the reason above: a hub that cannot reach its backplane
            // at boot still serves, and every cursor it hands out is merely behind rather
            // than wrong. `ready` must resolve or the handler that awaits it never runs.
          })

  const ready: Promise<void> = Promise.all([restored, joined]).then(() => undefined)

  /** This process's view of the sequence: its own ring, never behind where it joined. */
  function localCursor(): string {
    const own = core.cursor()
    return core.compareIds(joinedAt, own) > 0 ? joinedAt : own
  }

  /** The shared sequence's own answer, or this process's view if it cannot be had. */
  async function sharedCursor(): Promise<string> {
    if (backplane === undefined) return localCursor()
    try {
      const shared = await backplane.cursor()
      return core.compareIds(shared, localCursor()) > 0 ? shared : localCursor()
    } catch (error) {
      counters.errors.backplane++
      onError(error)
      return localCursor()
    }
  }

  if (backplane !== undefined) {
    backplane.onEvent((event) => {
      try {
        // Appending with the backplane's id keeps local history and the shared log in
        // agreement, so a cursor means the same thing in every process.
        const { frame, targets } = core.append(
          event.id,
          event.topic,
          event.payload,
          event.origin,
        )
        counters.received++
        fanOut(frame, targets)
      } catch (error) {
        counters.errors.backplane++
        onError(error)
      }
    })
  }

  // §6.2 — one shared interval rather than a timer per subscriber. N timers is the
  // usual implementation and it costs a timer per open tab for no benefit.
  let keepAlive: NodeJS.Timeout | undefined
  function ensureKeepAlive(): void {
    if (keepAlive !== undefined || keepAliveMs <= 0) return
    keepAlive = setInterval(() => {
      for (const conn of connections.values()) {
        // A connection that has not finished opening has no headers on it yet, and
        // `res.write` would flush Node's implicit ones — losing the content type, the
        // proxy-buffering hints and the §4.4 checkpoint, and making the `writeHead`
        // below throw. A keepalive is a liveness ping with nothing to say, so the
        // right thing is to skip this tick rather than queue it.
        if (conn.pending !== null) continue
        conn.res.write(FRAME_KEEPALIVE)
      }
    }, keepAliveMs)
    // Must not hold the process open — a hub with idle subscribers should still let
    // `node script.js` exit.
    keepAlive.unref?.()
  }
  function maybeStopKeepAlive(): void {
    if (connections.size === 0 && keepAlive !== undefined) {
      clearInterval(keepAlive)
      keepAlive = undefined
    }
  }

  /**
   * §8.2 — removal must be idempotent; both close events fire in the normal case.
   *
   * The idempotence is what makes `closed[reason]` trustworthy: a connection this hub
   * drops deliberately is deleted from the map before `res.end()` runs, so the `close`
   * event that follows finds nothing and the deliberate reason is the one recorded,
   * rather than being overwritten by the `client` close it causes.
   */
  function drop(id: number, reason: CloseReason, endFrame?: Uint8Array): void {
    const conn = connections.get(id)
    if (conn === undefined) return
    connections.delete(id)
    core.remove(id)
    counters.closed[reason]++
    try {
      // Same reason the keepalive skips a pending connection: writing a frame before
      // `writeHead` flushes Node's implicit headers. A connection dropped while still
      // opening is ended without an epilogue, and the handler sees it is gone and
      // answers 503 instead.
      if (endFrame !== undefined && conn.pending === null) conn.res.write(endFrame)
      if (conn.pending === null) conn.res.end()
    } catch {
      // The socket is already gone; nothing to report.
    }
    maybeStopKeepAlive()
  }

  /** Writes a frame to every matching subscriber. Returns how many were reached. */
  function fanOut(frame: Uint8Array, targets: readonly number[]): number {
    let delivered = 0
    for (const subId of targets) {
      const conn = connections.get(subId)
      if (conn === undefined) continue
      writeTo(conn, frame)
      delivered++
    }
    counters.delivered += delivered
    return delivered
  }

  /** How many local subscribers a topic has, for the publish acknowledgement. */
  function deliveredFor(topic: string): number {
    let n = 0
    for (const conn of connections.values()) {
      if (conn.topics.includes(topic)) n++
    }
    return n
  }

  function writeTo(conn: Connection, frame: Uint8Array): void {
    if (conn.pending !== null) {
      conn.pending.push(frame)
      return
    }
    conn.res.write(frame)
    // §8.2 — the socket is the only thing that knows the true outstanding depth.
    const verdict = core.noteBuffer(conn.id, conn.res.writableLength)
    if (verdict === 'slow-consumer') {
      drop(conn.id, 'slow-consumer', core.slowConsumerFrame(conn.id))
    }
  }

  return {
    /**
     * §2, §4.5 — assign an id, append to history, fan out.
     *
     * Returns a promise because a backplane owns id assignment, so the id is not known
     * until it answers. Not awaiting is fully supported: errors are routed to `onError`
     * rather than becoming an unhandled rejection.
     */
    publish(topic: string, data: unknown, options: PublishOptions = {}): Promise<PublishAck> {
      try {
        if (closed) throw new Error('hub is closed')
        const payload = (typeof data === 'string' ? data : JSON.stringify(data)) ?? ''
        const origin = options.origin

        if (backplane !== undefined) {
          // Validate before the round trip, so bad input fails fast and locally rather
          // than after a network hop.
          if (!core.validTopic(topic)) {
            throw new TypeError(`invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
          }
          if (origin !== undefined && origin !== '' && !core.validOrigin(origin)) {
            throw new TypeError(`invalid origin: ${JSON.stringify(origin.slice(0, 64))}`)
          }
          // Delivery happens when this event comes back through onEvent, along with
          // every other process's. One ordering, everywhere.
          return backplane.publish(topic, payload, origin).then(
            (id) => {
              // Counted here rather than at the call, because until the backplane has
              // accepted it there is no event: a write that fails reaches nobody, in
              // this process or any other.
              counters.published++
              return { id, delivered: deliveredFor(topic) }
            },
            (error) => {
              counters.errors.publish++
              onError(error)
              throw error
            },
          )
        }

        const { id, frame, targets } = core.publish(now(), topic, payload, origin)
        counters.published++
        const delivered = fanOut(frame, targets)

        if (store !== undefined) {
          // Written after delivery, and not awaited. An event that reached subscribers has
          // happened; making the publish wait on a disk write would put the store's
          // latency on the path of every live update, to protect only the replay a
          // restart would need.
          try {
            const written = store.append({ id, topic, payload, ...(origin !== undefined && origin !== '' && { origin }) })
            if (written instanceof Promise) {
              written.catch((error) => {
                counters.errors.history++
                onError(error)
              })
            }
          } catch (error) {
            counters.errors.history++
            onError(error)
          }
        }

        return Promise.resolve({ id, delivered })
      } catch (error) {
        counters.errors.publish++
        onError(error)
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },

    /**
     * A snapshot of what this hub has done and is doing — §10.
     *
     * Plain data, cheap enough to call on a scrape interval, and safe to serialise. Every
     * count is monotonic since `createHub` and `uptimeMs` comes with it, so rates are the
     * caller's to derive; see `HubStats` for why none are computed here.
     *
     * Deliberately not exposed as an endpoint. This library's premise is that your
     * authentication has already run before the hub sees a request, and a metrics route
     * mounted by the library would be the one thing in it that bypassed yours — connection
     * counts and rejection reasons are a description of your traffic. Mount it yourself,
     * behind whatever guards the rest of your operational surface.
     */
    stats(): HubStats {
      return snapshot(counters, now, connections.values())
    },

    /**
     * Resolves once a persistent history store has finished restoring the ring, and once
     * a backplane has reported where the shared log stood when this process joined it.
     *
     * Await it at boot if you want `hub.cursor()` to be meaningful before the first
     * request — the bootstrap endpoint in the quickstart reads it, and a cursor read
     * mid-restore, or before the shared log has answered, is behind. The stream handler
     * and `cursorHandler` await this internally, so forgetting it costs a microtask
     * rather than correctness.
     *
     * Resolves immediately when neither a store nor a backplane is configured, and never
     * rejects: a failure to restore or to reach the backplane is reported through
     * `onError` and leaves a hub that still serves.
     */
    ready(): Promise<void> {
      return ready
    },

    /**
     * §5 — the current cursor, for closing the cold-start window.
     *
     * With a backplane this is this process's view of the shared sequence: correct from
     * boot once `ready()` has resolved, and behind the shared log afterwards by at most
     * the reader's round trip — the events published elsewhere in the last millisecond
     * or so. Behind is the safe direction, and it is the direction this can only be in:
     * the extra events are replayed on connect rather than skipped.
     *
     * `sharedCursor()` pays a round trip to close that window exactly. Prefer it when a
     * replayed event is not idempotent for your client; this one when it is, or when the
     * cursor is being stamped on a response that cannot afford the wait.
     */
    cursor(): string {
      return localCursor()
    },

    /**
     * §5 — the newest id the *shared* sequence has assigned, asked of the backplane
     * rather than of this process.
     *
     * Identical to `cursor()` when no backplane is configured, where one process is the
     * whole sequence. Falls back to `cursor()` if the backplane cannot answer, because a
     * cold-start cursor that is merely behind still closes the window §5.1 is about,
     * while failing the page does not.
     */
    sharedCursor(): Promise<string> {
      return sharedCursor()
    },

    connectionCount(): number {
      return connections.size
    },

    /**
     * Evicts connections matching a predicate.
     *
     * §4.3's authorization runs once, at connect. A stream then outlives the decision
     * that permitted it, so a revoked session keeps receiving events until the tab
     * closes — unlike the polling it replaces, which re-authorized every request. This
     * is the escape hatch: call it from logout and permission-change paths.
     *
     * The push half of §4.6, in other words. `revalidateMs` on the handler is the pull
     * half, for revocations that happen somewhere this process never hears about.
     */
    disconnect<Req = IncomingMessage>(predicate: (req: Req) => boolean): number {
      let n = 0
      for (const conn of [...connections.values()]) {
        if (predicate(conn.appReq as Req)) {
          drop(conn.id, 'evicted')
          n++
        }
      }
      return n
    },

    close(): void {
      closed = true
      // Fire and forget: `close()` is synchronous by contract, and a store that fails to
      // flush on the way out must not become an unhandled rejection during shutdown.
      store?.close().catch((error) => {
        counters.errors.history++
        onError(error)
      })
      for (const id of [...connections.keys()]) drop(id, 'hub-closed')
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      if (keepAlive !== undefined) {
        clearInterval(keepAlive)
        keepAlive = undefined
      }
    },

    /**
     * §5 — `GET <mount>/cursor`.
     *
     * Answers for the shared sequence when there is one. This endpoint exists to be read
     * beside a page's data, so it is the one place that can afford the round trip to be
     * exact — and the one an application reaches for when it has not thought about which
     * process is answering, which is precisely when a per-process answer misleads.
     */
    cursorHandler() {
      return (_req: IncomingMessage, res: ServerResponse): void => {
        // Awaited exactly like the stream handler: an answer given mid-restore, or before
        // the shared log has said where it stands, is behind for no reason.
        void ready
          .then(sharedCursor)
          .then((cursor) => {
            res.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify({ cursor }))
          })
          .catch(onError) // The socket went away mid-answer; nothing left to reply to.
      }
    },

    /** §4 — the stream endpoint. Express-compatible; works with plain node:http too. */
    handler<Req = IncomingMessage>(
      // When `Req` is not an IncomingMessage, `toNodeRequest` stops being optional.
      // Forgetting it would hand `authorize` a raw request with none of the
      // framework's decorations on it — so the compiler asks for it instead.
      options?: HandlerOptions<Req> &
        (Req extends IncomingMessage ? unknown : { toNodeRequest: (req: Req) => IncomingMessage }),
    ) {
      const handlerOptions = (options ?? {}) as HandlerOptions<Req>
      const { authorize, connectionKey } = handlerOptions
      const toNode = handlerOptions.toNodeRequest ?? ((r: Req) => r as IncomingMessage)
      const owner = Symbol('aghoz.handler')

      const revalidateMs = handlerOptions.revalidateMs ?? 0
      if (revalidateMs > 0 && authorize !== undefined) {
        const timer = setInterval(() => {
          void revalidate()
        }, revalidateMs)
        timer.unref?.()
        timers.add(timer)
      }

      /**
       * Re-runs `authorize` for every connection this handler opened.
       *
       * Sequential rather than concurrent: an authorizer usually ends in a database or
       * a cache, and revalidating a thousand idle connections must not become a
       * thousand simultaneous queries on a timer. Slower is the correct default for
       * something the user never waits on.
       */
      async function revalidate(): Promise<void> {
        if (closed || authorize === undefined) return
        for (const conn of [...connections.values()]) {
          if (conn.owner !== owner) continue
          // Each authorize is awaited, so the connection may have closed by now.
          if (connections.get(conn.id) !== conn) continue

          let permitted = true
          for (const topic of conn.topics) {
            try {
              permitted = await authorize(conn.appReq as Req, topic)
            } catch (error) {
              counters.errors.authorize++
              onError(error)
              permitted = false
            }
            if (!permitted) break
          }
          if (!permitted && connections.get(conn.id) === conn) drop(conn.id, 'revalidated')
        }
      }

      return async (appReq: Req, res: ServerResponse): Promise<void> => {
        // Before anything else, and well before §4.5's atomic block. A request served
        // mid-restore would see an empty ring and report a gap to a client that had
        // missed nothing — the false positive D6 exists to prevent, reintroduced by the
        // feature meant to avoid refetches. A microtask when there is no store.
        await ready

        // `appReq` is what the framework decorated and what `authorize` sees.
        // `req` is the Node request that owns the socket and the close events.
        const req = toNode(appReq)

        // ---- §4.1 parse -------------------------------------------------------
        const search = req.url === undefined ? '' : req.url.slice(req.url.indexOf('?') + 1)
        const rawTopics = rawParam(search, 'topics')
        if (rawTopics === null || rawTopics === '') {
          return reject(res, 400, 'topics parameter is required')
        }

        let topics: string[]
        try {
          topics = rawTopics.split(',').map(decodeURIComponent)
        } catch {
          return reject(res, 400, 'topics contains malformed percent-encoding')
        }
        for (const topic of topics) {
          if (!core.validTopic(topic)) {
            return reject(res, 400, `invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
          }
        }

        // §4.1 — the header wins when both are present.
        const headerCursor = header(req, 'last-event-id')
        let rawCursor = headerCursor
        if (rawCursor === null) {
          const encoded = rawParam(search, 'last_event_id')
          if (encoded !== null) {
            try {
              rawCursor = decodeURIComponent(encoded)
            } catch {
              // §4.2 — a cursor that cannot be decoded cannot satisfy §2, so it is a 400,
              // exactly as `topics` above is. Reading it as "no cursor" would be the
              // silent downgrade the subscribe below refuses to make: the response would
              // carry no checkpoint, the client would have no way to learn its cursor was
              // discarded, and everything published since it would be gone unreported.
              // A cursor is the one parameter where being lenient loses data.
              return reject(res, 400, 'last_event_id contains malformed percent-encoding')
            }
          }
        }
        const cursor = rawCursor === null || rawCursor === '' ? undefined : rawCursor

        // ---- §4.3 authorize ---------------------------------------------------
        const allowed: string[] = []
        const denied: string[] = []
        if (authorize === undefined) {
          allowed.push(...topics)
        } else {
          for (const topic of topics) {
            let ok = false
            try {
              ok = await authorize(appReq, topic)
            } catch (error) {
              counters.errors.authorize++
              onError(error)
              return reject(res, 500, 'authorization failed')
            }
            ;(ok ? allowed : denied).push(topic)
          }
        }
        if (allowed.length === 0) return reject(res, 403, 'no requested topic is authorized')

        if (closed) return reject(res, 503, 'hub is closed')

        // ---- §4.5 the atomic block -------------------------------------------
        // NO `await` MAY APPEAR BETWEEN HERE AND THE END OF THIS BLOCK. Registration,
        // the checkpoint decision and the replay snapshot must describe one instant;
        // an await lets a publish land in between, and the gap goes unreported.
        const key = connectionKey?.(appReq)
        let subscribed
        try {
          subscribed = core.subscribe(allowed, key, cursor)
        } catch (error) {
          // Only the core's own rejections describe the *request*. Anything else — a
          // native binding that failed for a reason of its own, a bug in here — is this
          // server failing, and answering 400 for it tells the caller its request was
          // malformed while hiding a fault that is entirely ours. It also has to reach
          // `onError`: an operator cannot fix what nothing reports.
          if (!(error instanceof CoreError)) {
            counters.errors.core++
            onError(error)
            return reject(res, 500, 'core-error')
          }
          // A malformed cursor is a 400, never a silent downgrade to "no cursor": the
          // client would believe it resumed and would never be told otherwise.
          const reason = error.reason
          const status =
            reason === 'max-connections' || reason === 'max-connections-per-key' ? 429 : 400
          return reject(res, status, reason, status === 429 ? { 'retry-after': '5' } : {})
        }
        // The subscriber is registered now. From here a live frame may arrive at any
        // time, so it goes to `conn.pending` until the response is fully opened.
        const conn: Connection = {
          id: subscribed.id,
          nodeReq: req,
          appReq,
          res,
          topics: allowed,
          pending: [],
          owner,
        }
        connections.set(subscribed.id, conn)
        counters.opened++

        // §8.2 — registered here rather than after the response opens, because the
        // backplane branch below awaits. A client that aborts during that round trip
        // would otherwise leave a subscriber nothing ever removes: its `pending` array
        // grows with every publish for the lifetime of the process.
        const teardown = (): void => drop(subscribed.id, 'client')
        res.on('close', teardown)
        req.on('close', teardown)
        res.on('error', teardown)

        let truncated = subscribed.checkpoint === 'earliest'
        let replay: readonly Uint8Array[] = subscribed.replay

        // A bounded store discards its oldest entries, and the core's ring knows nothing
        // about a file compacted before this process booted. Without this the hub would
        // answer "you missed nothing" to a client whose events were thrown away by the
        // very store meant to preserve them.
        //
        // Equal is not a gap, matching the ring's own rule: that is the event the client
        // already holds.
        if (historyFloor !== undefined && cursor !== undefined && !truncated) {
          try {
            if (core.compareIds(cursor, historyFloor) < 0) truncated = true
          } catch (error) {
            // An unparseable floor is the store's bug, not the client's. Over-report
            // rather than risk claiming a gap-free stream we cannot vouch for.
            counters.errors.history++
            onError(error)
            truncated = true
          }
        }

        if (backplane !== undefined && cursor !== undefined) {
          // Shared history, because the client may have reconnected to a different
          // process than the one that served it last. This awaits inside what §4.5
          // calls the atomic block — which is only safe because registration happened
          // above, so nothing published during the round trip is lost. It may be
          // delivered twice instead, and the client dedupes by id.
          try {
            const shared = await backplane.replay(cursor, allowed)
            truncated = shared.truncated
            // Encoded, not appended: these events belong to the shared log, and pushing
            // them into this process's ring would duplicate what `onEvent` already
            // recorded — out of id order, on every reconnect.
            replay = shared.events.map((e) => core.encode(e.id, e.topic, e.payload, e.origin))
          } catch (error) {
            counters.errors.backplane++
            onError(error)
            // A backplane that cannot answer must not be reported as "nothing missed".
            truncated = true
            replay = []
          }
        }

        // The only await in this block is the backplane replay above, and the
        // connection can be dropped across it — by a client abort, by `disconnect()`,
        // or by `close()`. Writing headers now would be writing to a response someone
        // has already finished with.
        if (connections.get(subscribed.id) !== conn) {
          try {
            if (!res.headersSent) reject(res, 503, 'connection closed')
          } catch {
            // The socket went away underneath us; there is no one left to tell.
          }
          return
        }

        const headers: Record<string, string> = {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        }
        if (req.httpVersionMajor === 1) headers['connection'] = 'keep-alive'
        if (cursor !== undefined) {
          headers['last-event-id-checkpoint'] = truncated ? 'earliest' : cursor
        }
        res.writeHead(200, headers)
        res.flushHeaders?.()

        // §4.4 — without these the stream works locally and hangs behind a proxy.
        req.socket?.setNoDelay(true)
        req.socket?.setTimeout(0)
        res.setTimeout?.(0)

        ensureKeepAlive()

        res.write(FRAME_OK)
        // Counted where the frames are written rather than where they were decided, so a
        // connection lost across the backplane await — which returns above without
        // writing anything — never reports a truncation the client was not told about.
        if (denied.length > 0) {
          counters.denied++
          res.write(core.deniedFrame(denied))
        }
        if (truncated) {
          counters.truncated++
          res.write(core.truncatedFrame(subscribed.id))
        }
        counters.replayed += replay.length
        for (const frame of replay) res.write(frame)

        // Anything that arrived while replay was in flight, in the order it arrived.
        const queued = conn.pending ?? []
        conn.pending = null
        for (const frame of queued) res.write(frame)
        // ---- end of the atomic block -----------------------------------------
      }
    },
  }
}

/**
 * §4.1 — reads a query parameter WITHOUT decoding it.
 *
 * `URLSearchParams` decodes on access, which loses the boundary between a comma that
 * separates topics and a `%2C` inside one. The spec requires splitting first and
 * decoding each element after.
 */
function rawParam(search: string, name: string): string | null {
  for (const pair of search.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1)
  }
  return null
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  if (v === undefined) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

/**
 * Maps the status the handler chose onto the bucket it is counted in.
 *
 * `bad-request` is the default rather than a case so that a status added later is counted
 * as something instead of throwing or silently vanishing from the totals — a metric that
 * under-reports is the one failure mode worth engineering against here.
 */
function rejectReasonFor(status: number, message: string): RejectReason {
  switch (status) {
    case 403:
      return 'unauthorized'
    case 429:
      return 'over-capacity'
    case 500:
      // Two different 500s, and they are not the same operational problem: one is the
      // host application's `authorize` throwing, the other is the protocol core failing
      // underneath it. Counting them together would hide whichever is rarer.
      return message === 'core-error' ? 'core-error' : 'authorize-error'
    case 503:
      return 'unavailable'
    default:
      return 'bad-request'
  }
}

function fail(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify({ error: message }))
}
