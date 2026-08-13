/**
 * [`HubCore`] backed by the Rust core through its Node binding.
 *
 * The native module is *injected* rather than imported. That keeps
 * `@pushmount/server` at zero dependencies and free of a `.node` file — which matters,
 * because a native artefact in the default install path is what turns "npm install and
 * go" into a prebuild matrix and a bundler conversation. Callers that want the shared
 * core opt in explicitly:
 *
 * ```js
 * import { createRequire } from 'node:module'
 * const native = createRequire(import.meta.url)('@pushmount/node-core')
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
} from './core.js'

/** The surface `bindings/node` exposes. Structural, so no import is needed. */
export interface NativeModule {
  Hub: new (config: Record<string, number | undefined>) => NativeHub
  validateTopic(topic: string): boolean
  compareIds(a: string, b: string): number
}

interface NativeHub {
  publish(nowMs: number, topic: string, payload: string): {
    id: string
    frame: Uint8Array
    targets: number[]
  }
  subscribe(
    topics: string[],
    key: string | undefined | null,
    cursor: string | undefined | null,
  ): { id: number; checkpoint: string; replay: Uint8Array[] }
  noteBuffer(subscriber: number, queuedBytes: number): string
  remove(subscriber: number): boolean
  cursor(): string
  connectionCount(): number
  slowConsumerFrame(subscriber: number): Uint8Array
  truncatedFrame(subscriber: number): Uint8Array
  deniedFrame(topics: string[]): Uint8Array
}

/**
 * Maps the binding's thrown errors onto the seam's rejection reasons.
 *
 * napi surfaces a Rust `Err` as a thrown `Error` carrying the message the core chose,
 * so the mapping is on message text. The messages are part of the binding's contract
 * and are asserted in the parity tests, rather than being incidental strings.
 */
function toCoreError(error: unknown): CoreError {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('malformed cursor')) {
    return new CoreError('malformed-cursor', message)
  }
  if (message.includes('too-many-topics')) {
    return new CoreError('too-many-topics', message)
  }
  if (message.includes('max-connections-per-key')) {
    return new CoreError('max-connections-per-key', message)
  }
  if (message.includes('max-connections')) {
    return new CoreError('max-connections', message)
  }
  return new CoreError('invalid-topic', message)
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
    publish(nowMs, topic, payload) {
      try {
        return hub.publish(nowMs, topic, payload)
      } catch (error) {
        throw toCoreError(error)
      }
    },

    append(): never {
      // The Rust core has no externally-assigned-id path yet. It is opt-in and does not
      // ship (see DECISIONS.md D3), so this is a gap to close before a second language
      // binding needs a backplane — not before Node does.
      throw new Error(
        'the native core does not support a backplane yet; use the TypeScript core',
      )
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
        throw toCoreError(error)
      }
    },

    noteBuffer(subscriber, queuedBytes) {
      return hub.noteBuffer(subscriber, queuedBytes) as BufferKind
    },

    remove: (subscriber) => hub.remove(subscriber),
    cursor: () => hub.cursor(),
    connectionCount: () => hub.connectionCount(),
    slowConsumerFrame: (subscriber) => hub.slowConsumerFrame(subscriber),
    truncatedFrame: (subscriber) => hub.truncatedFrame(subscriber),
    deniedFrame: (topics) => hub.deniedFrame([...topics]),
    validTopic: (topic) => native.validateTopic(topic),
  }
}
