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
   * on the mutation, usually — and `@pushmount/client` drops its own echo.
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
  let closed = false

  if (options.suppressClusterWarning !== true) {
    const supervisor = detectCluster()
    if (supervisor !== null) {
      console.warn(
        `\n[pushmount] This process looks like one of several (${supervisor}), and the hub ` +
          `is in-memory.\n` +
          `           A publish here reaches only THIS process's subscribers. Clients ` +
          `connected to\n` +
          `           another worker will silently never receive it — nothing will error.\n` +
          `           Run a single process until a backplane ships, or set ` +
          `suppressClusterWarning.\n`,
      )
    }
  }

  const backplane = options.backplane
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
        fanOut(frame, targets)
      } catch (error) {
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

  /** §8.2 — removal must be idempotent; both close events fire in the normal case. */
  function drop(id: number, endFrame?: Uint8Array): void {
    const conn = connections.get(id)
    if (conn === undefined) return
    connections.delete(id)
    core.remove(id)
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
      drop(conn.id, core.slowConsumerFrame(conn.id))
    }
  }

  return {
    /**
     * §2, §4.5 — assign an id, append to history, fan out.
     *
     * Returns a promise so that the v0.3 backplane, which owns id assignment, does not
     * force a breaking change. Not awaiting is fully supported: errors are routed to
     * `onError` rather than becoming an unhandled rejection.
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
            (id) => ({ id, delivered: deliveredFor(topic) }),
            (error) => {
              onError(error)
              throw error
            },
          )
        }

        const { id, frame, targets } = core.publish(now(), topic, payload, origin)
        return Promise.resolve({ id, delivered: fanOut(frame, targets) })
      } catch (error) {
        onError(error)
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },

    /** §5 — the current cursor, for closing the cold-start window. */
    cursor(): string {
      return core.cursor()
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
          drop(conn.id)
          n++
        }
      }
      return n
    },

    close(): void {
      closed = true
      for (const id of [...connections.keys()]) drop(id)
      for (const timer of timers) clearInterval(timer)
      timers.clear()
      if (keepAlive !== undefined) {
        clearInterval(keepAlive)
        keepAlive = undefined
      }
    },

    /** §5 — `GET <mount>/cursor`. */
    cursorHandler() {
      return (_req: IncomingMessage, res: ServerResponse): void => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ cursor: core.cursor() }))
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
      const owner = Symbol('pushmount.handler')

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
              onError(error)
              permitted = false
            }
            if (!permitted) break
          }
          if (!permitted && connections.get(conn.id) === conn) drop(conn.id)
        }
      }

      return async (appReq: Req, res: ServerResponse): Promise<void> => {
        // `appReq` is what the framework decorated and what `authorize` sees.
        // `req` is the Node request that owns the socket and the close events.
        const req = toNode(appReq)

        // ---- §4.1 parse -------------------------------------------------------
        const search = req.url === undefined ? '' : req.url.slice(req.url.indexOf('?') + 1)
        const rawTopics = rawParam(search, 'topics')
        if (rawTopics === null || rawTopics === '') {
          return fail(res, 400, 'topics parameter is required')
        }

        let topics: string[]
        try {
          topics = rawTopics.split(',').map(decodeURIComponent)
        } catch {
          return fail(res, 400, 'topics contains malformed percent-encoding')
        }
        for (const topic of topics) {
          if (!core.validTopic(topic)) {
            return fail(res, 400, `invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
          }
        }

        // §4.1 — the header wins when both are present.
        const headerCursor = header(req, 'last-event-id')
        const rawCursor = headerCursor ?? decodeOrNull(rawParam(search, 'last_event_id'))
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
              onError(error)
              return fail(res, 500, 'authorization failed')
            }
            ;(ok ? allowed : denied).push(topic)
          }
        }
        if (allowed.length === 0) return fail(res, 403, 'no requested topic is authorized')

        if (closed) return fail(res, 503, 'hub is closed')

        // ---- §4.5 the atomic block -------------------------------------------
        // NO `await` MAY APPEAR BETWEEN HERE AND THE END OF THIS BLOCK. Registration,
        // the checkpoint decision and the replay snapshot must describe one instant;
        // an await lets a publish land in between, and the gap goes unreported.
        const key = connectionKey?.(appReq)
        let subscribed
        try {
          subscribed = core.subscribe(allowed, key, cursor)
        } catch (error) {
          const reason = error instanceof CoreError ? error.reason : 'invalid-topic'
          // A malformed cursor is a 400, never a silent downgrade to "no cursor": the
          // client would believe it resumed and would never be told otherwise.
          const status =
            reason === 'max-connections' || reason === 'max-connections-per-key' ? 429 : 400
          return fail(res, status, reason, status === 429 ? { 'retry-after': '5' } : {})
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

        // §8.2 — registered here rather than after the response opens, because the
        // backplane branch below awaits. A client that aborts during that round trip
        // would otherwise leave a subscriber nothing ever removes: its `pending` array
        // grows with every publish for the lifetime of the process.
        const teardown = (): void => drop(subscribed.id)
        res.on('close', teardown)
        req.on('close', teardown)
        res.on('error', teardown)

        let truncated = subscribed.checkpoint === 'earliest'
        let replay: readonly Uint8Array[] = subscribed.replay

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
            if (!res.headersSent) fail(res, 503, 'connection closed')
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
        if (denied.length > 0) res.write(core.deniedFrame(denied))
        if (truncated) res.write(core.truncatedFrame(subscribed.id))
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

function decodeOrNull(raw: string | null): string | null {
  if (raw === null) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name]
  if (v === undefined) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
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
