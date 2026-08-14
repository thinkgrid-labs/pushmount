/**
 * @pushmount/redis — a backplane on Redis Streams.
 *
 * Streams are the right primitive rather than pub/sub, for one reason that decides
 * everything else: **`XADD` assigns exactly the `<ms>-<seq>` id this protocol uses**.
 * §2 fixed that format so a shared sequencer could issue it, and Redis is that
 * sequencer — no per-process counter, no collision between pods, no client silently
 * discarding a real event as already-seen.
 *
 * The stream is also the shared history, so `XRANGE key (cursor +` is the replay a
 * client needs after reconnecting to a different process. Pub/sub would give fan-out
 * and nothing else: no ids, no history, no way to answer "did I miss anything".
 *
 * The Redis client is injected rather than imported, so this package has no third-party
 * runtime dependency and works with ioredis, node-redis, or anything presenting the
 * same handful of commands.
 */

import type { Backplane, BackplaneEvent, BackplaneReplay } from '@pushmount/server'

/** The commands this backplane needs. Both ioredis and node-redis satisfy it. */
export interface RedisLike {
  xadd(...args: (string | number)[]): Promise<string | null>
  xrange(key: string, start: string, end: string, ...rest: (string | number)[]): Promise<StreamEntry[]>
  xrevrange(key: string, start: string, end: string, ...rest: (string | number)[]): Promise<StreamEntry[]>
  xread(...args: (string | number)[]): Promise<StreamReadReply | null>
  quit?(): Promise<unknown>
  disconnect?(): void
}

/** `[id, [field, value, field, value, ...]]` */
export type StreamEntry = [string, string[]]
/** `[[streamKey, entries], ...]` */
export type StreamReadReply = [string, StreamEntry[]][]

export interface RedisBackplaneOptions {
  /** Used for XADD, XRANGE and XREVRANGE. */
  redis: RedisLike
  /**
   * A **second** connection, used only for the blocking read.
   *
   * `XREAD BLOCK` monopolises its connection for the duration of the block, so sharing
   * one client would stall every publish behind the reader. This is the single most
   * common way a Redis Streams integration is got wrong.
   */
  subscriber: RedisLike
  /** Stream key. Default `pushmount:events`. */
  key?: string
  /**
   * Approximate cap on retained events — the shared equivalent of `maxHistoryBytes`.
   *
   * Redis trims by entry count, not bytes, so this is a count. `~` is used so Redis may
   * trim at a node boundary, which is dramatically cheaper and is why the cap is
   * approximate.
   */
  maxLen?: number
  /** How long a blocking read waits before looping, in ms. Default 5000. */
  blockMs?: number
  /**
   * The most entries one reconnect may scan out of shared history. Default 1000.
   *
   * The cursor is supplied by the client, so without a bound a single request saying
   * `last_event_id=0-0` reads the entire retained stream — `maxLen` entries by default
   * — re-encodes every one of them and writes the lot to one socket. That is a request
   * amplification anyone can aim at the hub, and it costs the same whether it is
   * malicious or a laptop that was closed for a week.
   *
   * Past the cap the answer is a gap, not a partial replay. Serving the first N and
   * stopping would leave a hole between them and live events while the client's cursor
   * advanced past it — the client would believe it had caught up, which is exactly the
   * silent loss §8 exists to make impossible. A gap tells it to refetch instead.
   */
  maxReplay?: number
  onError?: (error: unknown) => void
}

const FIELD_TOPIC = 't'
const FIELD_PAYLOAD = 'p'

export async function createRedisBackplane(
  options: RedisBackplaneOptions,
): Promise<Backplane> {
  const { redis, subscriber } = options
  const key = options.key ?? 'pushmount:events'
  const maxLen = options.maxLen ?? 10_000
  const blockMs = options.blockMs ?? 5_000
  const maxReplay = options.maxReplay ?? 1_000
  const onError = options.onError ?? (() => {})

  let sink: ((event: BackplaneEvent) => void) | undefined
  let running = true

  // Start reading from whatever exists now, not from '$'. With '$' the reader would
  // begin at the *next* event, so anything published between this call and the first
  // XREAD would never be delivered to this process.
  let lastRead = await newestId(redis, key)

  async function loop(): Promise<void> {
    while (running) {
      try {
        const reply = await subscriber.xread('BLOCK', blockMs, 'STREAMS', key, lastRead)
        if (!running) return
        if (reply === null) continue // block expired with nothing new
        for (const [, entries] of reply) {
          for (const [id, fields] of entries) {
            lastRead = id
            const event = toEvent(id, fields)
            if (event !== null && sink !== undefined) sink(event)
          }
        }
      } catch (error) {
        if (!running) return
        onError(error)
        // Back off briefly rather than spinning on a dead connection.
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  void loop()

  return {
    async publish(topic, payload) {
      const id = await redis.xadd(
        key,
        'MAXLEN',
        '~',
        maxLen,
        '*',
        FIELD_TOPIC,
        topic,
        FIELD_PAYLOAD,
        payload,
      )
      if (id === null) throw new Error('XADD returned no id')
      return id
    },

    onEvent(next) {
      sink = next
    },

    async replay(cursor, topics): Promise<BackplaneReplay> {
      const oldest = await redis.xrange(key, '-', '+', 'COUNT', 1)
      const oldestId = oldest[0]?.[0]

      // Nothing retained means nothing can have been missed from it.
      if (oldestId === undefined) return { truncated: false, events: [] }

      // `(cursor` is exclusive, which matches "strictly newer than the cursor".
      // One past the cap, so the overflow is detectable rather than inferred.
      const entries = await redis.xrange(key, `(${cursor}`, '+', 'COUNT', maxReplay + 1)
      // Too far behind to serve honestly — see `maxReplay`. Reported as a gap, which is
      // the same answer a trimmed history gives, for the same reason.
      if (entries.length > maxReplay) return { truncated: true, events: [] }

      const wanted = new Set(topics)
      const events: BackplaneEvent[] = []
      for (const [id, fields] of entries) {
        const event = toEvent(id, fields)
        if (event !== null && wanted.has(event.topic)) events.push(event)
      }

      return { truncated: compareIds(cursor, oldestId) < 0, events }
    },

    async cursor() {
      return newestId(redis, key)
    },

    async close() {
      running = false
      // The reader may be parked in a BLOCK; disconnect is what interrupts it.
      subscriber.disconnect?.()
      await subscriber.quit?.().catch(() => {})
    },
  }
}

async function newestId(redis: RedisLike, key: string): Promise<string> {
  const newest = await redis.xrevrange(key, '+', '-', 'COUNT', 1)
  return newest[0]?.[0] ?? '0-0'
}

function toEvent(id: string, fields: string[]): BackplaneEvent | null {
  let topic: string | undefined
  let payload: string | undefined
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === FIELD_TOPIC) topic = fields[i + 1]
    else if (fields[i] === FIELD_PAYLOAD) payload = fields[i + 1]
  }
  // An entry written by something else sharing the key is skipped rather than
  // delivered as a malformed event.
  if (topic === undefined || payload === undefined) return null
  return { id, topic, payload }
}

/**
 * §2.1 — compare by parsed halves.
 *
 * Duplicated rather than imported so this package keeps no runtime dependency on the
 * server's internals; the shared corpus covers the rule.
 */
function compareIds(a: string, b: string): number {
  const [aMs = 0, aSeq = 0] = a.split('-').map(Number)
  const [bMs = 0, bSeq = 0] = b.split('-').map(Number)
  if (aMs !== bMs) return aMs < bMs ? -1 : 1
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1
  return 0
}
