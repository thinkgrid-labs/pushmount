/**
 * The pure-TypeScript implementation of [`HubCore`], over `hub.ts` and `registry.ts`.
 *
 * Zero dependencies, no native artefact, works anywhere Node runs. Kept as a first-class
 * path rather than a fallback: it is what makes `npm install` and go true, and it is the
 * second implementation the conformance corpus exists to keep honest.
 */

import {
  Hub,
  encodeControl,
  encodeFrame,
  formatId,
  parseId,
  validOrigin,
  validTopic,
} from './hub.js'
import { Registry } from './registry.js'
import {
  CoreError,
  type BufferKind,
  type CoreConfig,
  type HubCore,
  type PublishOutcome,
  type SubscribeOutcome,
} from './core.js'

export function createTsCore(config: CoreConfig = {}): HubCore {
  const hub = new Hub(
    config.maxHistoryBytes === undefined ? {} : { maxHistoryBytes: config.maxHistoryBytes },
  )
  const registry = new Registry({
    ...(config.maxBufferBytes !== undefined && { maxBufferBytes: config.maxBufferBytes }),
    ...(config.maxConnections !== undefined && { maxConnections: config.maxConnections }),
    ...(config.maxConnectionsPerKey !== undefined && {
      maxConnectionsPerKey: config.maxConnectionsPerKey,
    }),
    ...(config.maxTopicsPerConnection !== undefined && {
      maxTopicsPerConnection: config.maxTopicsPerConnection,
    }),
  })

  return {
    publish(nowMs, topic, payload, origin): PublishOutcome {
      const { id, frame } = hub.publish(nowMs, topic, payload, origin)
      return { id: formatId(id), frame, targets: registry.match(topic) }
    },

    append(id, topic, payload, origin): PublishOutcome {
      const parsed = parseId(id)
      if (parsed === null) throw new CoreError('malformed-cursor', `malformed id: ${id}`)
      const appended = hub.append(parsed, topic, payload, origin)
      return { id, frame: appended.frame, targets: registry.match(topic) }
    },

    encode(id, topic, payload, origin): Uint8Array {
      const parsed = parseId(id)
      if (parsed === null) throw new CoreError('malformed-cursor', `malformed id: ${id}`)
      if (!validTopic(topic)) {
        throw new CoreError('invalid-topic', `invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
      }
      if (origin !== undefined && origin !== '' && !validOrigin(origin)) {
        throw new CoreError('invalid-origin', `invalid origin: ${JSON.stringify(origin.slice(0, 64))}`)
      }
      return encodeFrame(parsed.ms, parsed.seq, topic, payload, origin)
    },

    subscribe(topics, key, cursor): SubscribeOutcome {
      const parsed = cursor === undefined ? null : parseId(cursor)
      if (cursor !== undefined && parsed === null) {
        throw new CoreError('malformed-cursor', `malformed cursor: ${JSON.stringify(cursor)}`)
      }
      for (const topic of topics) {
        if (!validTopic(topic)) {
          throw new CoreError('invalid-topic', `invalid topic: ${JSON.stringify(topic.slice(0, 64))}`)
        }
      }

      const added = registry.add(topics, key)
      if (!added.ok) {
        const reason =
          added.reason === 'too-many-topics'
            ? 'too-many-topics'
            : added.reason === 'max-connections'
              ? 'max-connections'
              : 'max-connections-per-key'
        throw new CoreError(reason, reason)
      }

      // Registration first, then the snapshot — and nothing may await in between, or a
      // publish can trim history after the checkpoint has already said "nothing missed".
      const { truncated, frames } = hub.checkpointAndReplay(parsed, topics)
      return {
        id: added.id,
        checkpoint: parsed === null ? 'absent' : truncated ? 'earliest' : 'echo',
        replay: frames,
      }
    },

    noteBuffer(subscriber, queuedBytes): BufferKind {
      return registry.noteBuffer(subscriber, queuedBytes)
    },

    remove(subscriber) {
      return registry.remove(subscriber)
    },

    cursor() {
      return hub.cursor()
    },

    connectionCount() {
      return registry.size
    },

    slowConsumerFrame(subscriber) {
      return encodeControl('gap', {
        reason: 'slow-consumer',
        topics: registry.topicsOf(subscriber),
      })
    },

    truncatedFrame(subscriber) {
      return encodeControl('gap', {
        reason: 'history-truncated',
        topics: registry.topicsOf(subscriber),
      })
    },

    deniedFrame(topics) {
      return encodeControl('denied', { topics })
    },

    validTopic,
    validOrigin,
  }
}
