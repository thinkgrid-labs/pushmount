/**
 * [`HubCore`] backed by the Rust core through its Node binding.
 *
 * The native module is *injected* rather than imported. That keeps
 * `@aghoz/server` at zero dependencies and free of a `.node` file — which matters,
 * because a native artefact in the default install path is what turns "npm install and
 * go" into a prebuild matrix and a bundler conversation. Callers that want the shared
 * core opt in explicitly:
 *
 * ```js
 * import { createRequire } from 'node:module'
 * const native = createRequire(import.meta.url)('@aghoz/node-core')
 * const hub = createHub({ core: createNativeCore(native) })
 * ```
 *
 * Everything above this file is unchanged either way, which is the point: the whole
 * server test suite is the core's acceptance suite.
 */

import {
  CoreError,
  type BufferKind,
  type CheckpointKind,
  type CoreConfig,
  type HubCore,
  type SubscribeRejection,
} from './core.js'

/** The surface `bindings/node` exposes. Structural, so no import is needed. */
export interface NativeModule {
  Hub: new (config: Record<string, number | undefined>) => NativeHub
  validateTopic(topic: string): boolean
  validateOrigin(origin: string): boolean
  compareIds(a: string, b: string): number
}

interface NativeHub {
  publish(nowMs: number, topic: string, payload: string, origin?: string | null): {
    id: string
    frame: Uint8Array
    targets: number[]
  }
  append(id: string, topic: string, payload: string, origin?: string | null): {
    id: string
    frame: Uint8Array
    targets: number[]
  }
  encode(id: string, topic: string, payload: string, origin?: string | null): Uint8Array
  subscribe(
    topics: string[],
    key: string | undefined | null,
    cursor: string | undefined | null,
  ): { id: number; checkpoint: string; replay: Uint8Array[] }
  noteBuffer(subscriber: number, queuedBytes: number): string
  noteSent(subscriber: number, bytes: number): string
  noteFlushed(subscriber: number, bytes: number): string
  remove(subscriber: number): boolean
  cursor(): string
  connectionCount(): number
  slowConsumerFrame(subscriber: number): Uint8Array
  truncatedFrame(subscriber: number): Uint8Array
  deniedFrame(topics: string[]): Uint8Array
}

/**
 * The reason tokens the binding puts at the front of every rejection it means.
 *
 * A closed set, and the whole contract between the two halves. napi has exactly two
 * string channels — the JS error's `code`, which it fills with its own coarse status, and
 * the message — so the reason travels as the message's first `:`-delimited segment:
 * `too-many-topics`, or `invalid-topic: topic exceeds 255 bytes`.
 */
const REASONS: Readonly<Record<string, SubscribeRejection>> = {
  'invalid-topic': 'invalid-topic',
  'invalid-origin': 'invalid-origin',
  'too-many-topics': 'too-many-topics',
  'max-connections': 'max-connections',
  'max-connections-per-key': 'max-connections-per-key',
  // The append and encode paths reject a non-canonical §2.1 id under the cursor's reason,
  // as the TypeScript core does. A binding-specific third reason would be a difference
  // the seam has no use for.
  'malformed-cursor': 'malformed-cursor',
}

/**
 * Maps the binding's thrown errors onto the seam's rejection reasons — and, just as
 * importantly, declines to map the ones that are not rejections at all.
 *
 * This used to search the message for substrings and call whatever matched nothing an
 * `invalid-topic`. Every error the binding could produce for a reason of its own — a napi
 * argument conversion that failed, a Rust panic unwound through the boundary, an addon
 * built against a different version — arrived at the client as `400 invalid-topic`. The
 * server told the caller its request was malformed while the fault was entirely the
 * server's, `onError` was never called, and the counter it landed in was `bad-request`.
 * A broken native core was invisible in the metrics and blamed on whoever asked.
 *
 * So an unrecognised error is returned unchanged, and the handler above answers 500 for
 * it. That includes the case where the addon and this package disagree about the tokens,
 * which is a version skew — loud is the only useful behaviour there.
 */
function asCoreError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  const separator = message.indexOf(':')
  const token = separator === -1 ? message : message.slice(0, separator)
  const reason = REASONS[token]
  if (reason === undefined) return error
  return new CoreError(reason, message)
}

export function createNativeCore(native: NativeModule, config: CoreConfig = {}): HubCore {
  const hub = new native.Hub({
    maxHistoryBytes: config.maxHistoryBytes,
    maxBufferBytes: config.maxBufferBytes,
    maxConnections: config.maxConnections,
    maxConnectionsPerKey: config.maxConnectionsPerKey,
    maxTopicsPerConnection: config.maxTopicsPerConnection,
  })

  return {
    publish(nowMs, topic, payload, origin) {
      try {
        return hub.publish(nowMs, topic, payload, origin ?? null)
      } catch (error) {
        throw asCoreError(error)
      }
    },

    append(id, topic, payload, origin) {
      try {
        return hub.append(id, topic, payload, origin ?? null)
      } catch (error) {
        throw asCoreError(error)
      }
    },

    encode(id, topic, payload, origin) {
      try {
        return hub.encode(id, topic, payload, origin ?? null)
      } catch (error) {
        throw asCoreError(error)
      }
    },

    subscribe(topics, key, cursor) {
      try {
        const result = hub.subscribe([...topics], key ?? null, cursor ?? null)
        return {
          id: result.id,
          checkpoint: result.checkpoint as CheckpointKind,
          replay: result.replay,
        }
      } catch (error) {
        throw asCoreError(error)
      }
    },

    noteBuffer(subscriber, queuedBytes) {
      return hub.noteBuffer(subscriber, queuedBytes) as BufferKind
    },

    noteSent(subscriber, bytes) {
      return hub.noteSent(subscriber, bytes) as BufferKind
    },

    noteFlushed(subscriber, bytes) {
      return hub.noteFlushed(subscriber, bytes) as BufferKind
    },

    remove: (subscriber) => hub.remove(subscriber),
    cursor: () => hub.cursor(),
    connectionCount: () => hub.connectionCount(),
    slowConsumerFrame: (subscriber) => hub.slowConsumerFrame(subscriber),
    truncatedFrame: (subscriber) => hub.truncatedFrame(subscriber),
    deniedFrame: (topics) => hub.deniedFrame([...topics]),
    compareIds: (a, b) => native.compareIds(a, b),
    validTopic: (topic) => native.validateTopic(topic),
    validOrigin: (origin) => native.validateOrigin(origin),
  }
}
