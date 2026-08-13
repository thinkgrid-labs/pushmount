/**
 * The HTTP layer — PROTOCOL.md §4, §5, §7, §8.
 *
 * Everything that touches a socket lives here. `hub.ts` and `registry.ts` stay pure so
 * the conformance corpus can own them; this module owns ordering, headers and teardown,
 * which are the parts that only fail in production.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Hub, type EventId, encodeControl, formatId, parseId, validTopic } from './hub.js'
import { Registry } from './registry.js'

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
}

export interface PublishAck {
  readonly id: string
  /** Subscribers the frame was written to. Not a delivery guarantee. */
  readonly delivered: number
}

interface Connection {
  readonly id: number
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly topics: readonly string[]
}

export function createHub(options: CreateHubOptions = {}) {
  const hub = new Hub(
    options.maxHistoryBytes === undefined ? {} : { maxHistoryBytes: options.maxHistoryBytes },
  )
  const registry = new Registry({
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

  // §6.2 — one shared interval rather than a timer per subscriber. N timers is the
  // usual implementation and it costs a timer per open tab for no benefit.
  let keepAlive: NodeJS.Timeout | undefined
  function ensureKeepAlive(): void {
    if (keepAlive !== undefined || keepAliveMs <= 0) return
    keepAlive = setInterval(() => {
      for (const conn of connections.values()) conn.res.write(FRAME_KEEPALIVE)
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
    registry.remove(id)
    try {
      if (endFrame !== undefined) conn.res.write(endFrame)
      conn.res.end()
    } catch {
      // The socket is already gone; nothing to report.
    }
    maybeStopKeepAlive()
  }

  function writeTo(conn: Connection, frame: Uint8Array): void {
    conn.res.write(frame)
    // §8.2 — the socket is the only thing that knows the true outstanding depth.
    const verdict = registry.noteBuffer(conn.id, conn.res.writableLength)
    if (verdict === 'slow-consumer') {
      drop(
        conn.id,
        encodeControl('gap', { reason: 'slow-consumer', topics: conn.topics }),
      )
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
    publish(topic: string, data: unknown): Promise<PublishAck> {
      try {
        if (closed) throw new Error('hub is closed')
        const payload = typeof data === 'string' ? data : JSON.stringify(data)
        const { id, frame } = hub.publish(now(), topic, payload ?? '')

        let delivered = 0
        for (const subId of registry.match(topic)) {
          const conn = connections.get(subId)
          if (conn === undefined) continue
          writeTo(conn, frame)
          delivered++
        }
        return Promise.resolve({ id: formatId(id), delivered })
      } catch (error) {
        onError(error)
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },

    /** §5 — the current cursor, for closing the cold-start window. */
    cursor(): string {
      return hub.cursor()
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
     */
    disconnect(predicate: (req: IncomingMessage) => boolean): number {
      let n = 0
      for (const conn of [...connections.values()]) {
        if (predicate(conn.req)) {
          drop(conn.id)
          n++
        }
      }
      return n
    },

    close(): void {
      closed = true
      for (const id of [...connections.keys()]) drop(id)
      if (keepAlive !== undefined) {
        clearInterval(keepAlive)
        keepAlive = undefined
      }
    },

    /** §5 — `GET <mount>/cursor`. */
    cursorHandler() {
      return (_req: IncomingMessage, res: ServerResponse): void => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ cursor: hub.cursor() }))
      }
    },

    /** §4 — the stream endpoint. Express-compatible; works with plain node:http too. */
    handler<Req extends IncomingMessage>(handlerOptions: HandlerOptions<Req> = {}) {
      const { authorize, connectionKey } = handlerOptions

      return async (req: Req, res: ServerResponse): Promise<void> => {
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
          if (!validTopic(topic)) {
            return fail(res, 400, `invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
          }
        }

        // §4.1 — the header wins when both are present.
        const headerCursor = header(req, 'last-event-id')
        const rawCursor = headerCursor ?? decodeOrNull(rawParam(search, 'last_event_id'))
        let cursor: EventId | null = null
        if (rawCursor !== null && rawCursor !== '') {
          cursor = parseId(rawCursor)
          // A malformed cursor must not be silently downgraded to "no cursor" — the
          // client would believe it resumed and would never be told it did not.
          if (cursor === null) return fail(res, 400, 'malformed cursor')
        }

        // ---- §4.3 authorize ---------------------------------------------------
        const allowed: string[] = []
        const denied: string[] = []
        if (authorize === undefined) {
          allowed.push(...topics)
        } else {
          for (const topic of topics) {
            let ok = false
            try {
              ok = await authorize(req, topic)
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
        const key = connectionKey?.(req)
        const added = registry.add(allowed, key)
        if (!added.ok) {
          const status = added.reason === 'too-many-topics' ? 400 : 429
          return fail(res, status, added.reason, status === 429 ? { 'retry-after': '5' } : {})
        }

        const { truncated, frames } = hub.checkpointAndReplay(cursor, allowed)

        const headers: Record<string, string> = {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        }
        if (req.httpVersionMajor === 1) headers['connection'] = 'keep-alive'
        if (cursor !== null) {
          headers['last-event-id-checkpoint'] = truncated ? 'earliest' : formatId(cursor)
        }
        res.writeHead(200, headers)
        res.flushHeaders?.()

        // §4.4 — without these the stream works locally and hangs behind a proxy.
        req.socket?.setNoDelay(true)
        req.socket?.setTimeout(0)
        res.setTimeout?.(0)

        const conn: Connection = { id: added.id, req, res, topics: allowed }
        connections.set(added.id, conn)
        ensureKeepAlive()

        res.write(FRAME_OK)
        if (denied.length > 0) res.write(encodeControl('denied', { topics: denied }))
        if (truncated) {
          res.write(encodeControl('gap', { reason: 'history-truncated', topics: allowed }))
        }
        for (const frame of frames) res.write(frame)
        // ---- end of the atomic block -----------------------------------------

        // §8.2 — both events, or every tab that ever connected leaks a subscriber.
        const teardown = (): void => drop(added.id)
        res.on('close', teardown)
        req.on('close', teardown)
        res.on('error', teardown)
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
