/**
 * @pushmount/client
 *
 * A framework-agnostic browser client for the pushmount wire protocol.
 *
 * Built on `fetch` and `ReadableStream` rather than `EventSource`, because
 * `EventSource` cannot read response headers and the checkpoint that reports missed
 * updates is a header. Gap detection is impossible with it — see PROTOCOL.md §4.4.
 *
 * Zero runtime dependencies.
 */

export {
  Client,
  createClient,
  type ClientOptions,
  type ClientState,
  type GapReason,
  type Handler,
  type EventMeta,
} from './client.js'

export { SseParser, compareIds, type ParsedEvent } from './parser.js'
