// Emits scenarios.json — the HTTP half of the conformance corpus.
//
// Same rule as vectors.json, and for the same reason: every expectation below is written
// out from PROTOCOL.md by hand, never captured from a running server. A corpus recorded
// from an implementation only proves that implementation is self-consistent, and would
// have blessed each of the three bugs this project has already paid for.
//
// Where vectors.json pins the protocol *core* — bytes in, bytes out, no sockets — this
// pins the layer above it: statuses, headers, write order, teardown. That layer is
// rewritten in full by every language, and until this file existed nothing checked it.
//
// Regenerate with: node build-scenarios.mjs

import { writeFileSync } from 'node:fs'

/** Frames the server sends before anything scenario-specific — §4.5 step 4. */
const OK = ':ok\n\n'

/**
 * A payload big enough that three of them overflow a 200-byte history budget.
 *
 * Each frame is 120 bytes of payload plus its `id:`/`event:`/`data:` scaffolding, so a
 * 200-byte ring holds exactly one. Sized deliberately: the eviction has to reach *past*
 * the cursor a scenario presents, or the checkpoint is correctly `echo` and the scenario
 * proves nothing. D6 is the reason — a cursor equal to the newest evicted id is NOT a gap,
 * because that is the event the client already holds.
 */
const BIG = 'x'.repeat(120)

const scenarios = {
  version: '0.1',
  spec: 'PROTOCOL.md',
  note:
    'Driven over real HTTP against an adapter test app (see README.md). The app pins the ' +
    'clock, so event ids are deterministic and frames compare byte-for-byte.',

  // ---- §4.1 request parsing ------------------------------------------------
  //
  // Everything here is a 400, and the interesting part is *which* inputs reach one. A
  // server that is lax about any of them opens a stream that is subtly not the one the
  // client asked for, and nothing downstream ever notices.
  request: [
    {
      id: 'H1', ref: '§4.1', desc: 'a request with no topics parameter is refused',
      steps: [{ op: 'request', path: '/events', expect: { status: 400 } }],
    },
    {
      id: 'H2', ref: '§4.1', desc: 'an empty topics parameter is refused rather than treated as "all topics"',
      steps: [{ op: 'request', path: '/events?topics=', expect: { status: 400 } }],
    },
    {
      id: 'H3', ref: '§4.1', desc: 'malformed percent-encoding is refused rather than passed through raw',
      steps: [{ op: 'request', path: '/events?topics=%ZZ', expect: { status: 400 } }],
    },
    {
      id: 'H4', ref: '§3', desc: 'a reserved topic is refused at the endpoint, not just at publish — otherwise a subscriber can name a control frame',
      steps: [{ op: 'request', path: '/events?topics=%7Egap', expect: { status: 400 } }],
    },
    {
      id: 'H5', ref: '§3', desc: 'a topic containing a control character is refused',
      steps: [{ op: 'request', path: '/events?topics=a%0Ab', expect: { status: 400 } }],
    },
    {
      id: 'H6', ref: '§4.1', desc: 'topics are split on comma BEFORE decoding, so %2C is a comma inside one topic and not a separator',
      steps: [
        // Two topics would be `a` and `b`; one topic is the four characters `a,b`. The
        // difference is visible in what a publish to `a,b` reaches.
        { op: 'open', as: 's', path: '/events?topics=a%2Cb' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'publish', topic: 'a', payload: 'wrong' },
        { op: 'publish', topic: 'a,b', payload: 'right' },
        { op: 'expect-frames', of: 's', frames: ['id: 1000-1\nevent: a,b\ndata: right\n\n'] },
      ],
    },
    {
      id: 'H7', ref: '§4.1', desc: 'a malformed cursor is a 400, never a silent downgrade to a live-only stream',
      steps: [{ op: 'request', path: '/events?topics=t&last_event_id=nonsense', expect: { status: 400 } }],
    },
    {
      id: 'H42', ref: '§4.1',
      desc: 'a cursor with malformed percent-encoding is a 400, not a decode failure quietly read as "no cursor"',
      steps: [
        // The mirror of H3, and the one an implementation is far likelier to get wrong:
        // decoding `topics` and decoding `last_event_id` are the same operation, but a
        // failure means different things. A `topics` decode that fails has nothing to
        // subscribe to and fails loudly on its own. A cursor decode that fails still has
        // a perfectly serviceable request underneath it, so the tempting shape — decode,
        // fall back to null, carry on — opens a live-only stream. The client presented a
        // cursor, gets no `last-event-id-checkpoint` back because the server believes
        // there was none, and every event published since is gone with nothing reported.
        { op: 'request', path: '/events?topics=t&last_event_id=%ZZ', expect: { status: 400 } },
        // A truncated UTF-8 sequence is the same failure without the obvious tell: the
        // escapes are well-formed and it is the multi-byte character they spell that is
        // incomplete, so a hand-rolled `%XX` validator passes it and `decodeURIComponent`
        // still throws.
        { op: 'request', path: '/events?topics=t&last_event_id=%E0%A4%A', expect: { status: 400 } },
      ],
    },
    {
      id: 'H8', ref: '§2.1', desc: 'a non-canonical cursor is refused — leading zeros would resolve to a different event elsewhere',
      steps: [
        { op: 'request', path: '/events?topics=t', headers: { 'last-event-id': '01-0' }, expect: { status: 400 } },
      ],
    },
    {
      id: 'H9', ref: '§2', desc: 'a cursor above the 2^53-1 bound is refused rather than truncated to something representable',
      steps: [
        {
          op: 'request', path: '/events?topics=t',
          headers: { 'last-event-id': '9007199254740992-0' },
          expect: { status: 400 },
        },
      ],
    },
    {
      id: 'H10', ref: '§11', desc: 'an unknown query parameter is ignored rather than refused',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t&future=1' },
        { op: 'expect-frames', of: 's', frames: [OK] },
      ],
    },
  ],

  // ---- §4.2 / §4.3 authorization ------------------------------------------
  //
  // The library's entire premise is that the host's auth ran first, so these statuses are
  // the contract an adapter is judged on. A 403 where a 429 belongs sends a client into a
  // sign-in loop instead of a backoff.
  authorize: [
    {
      id: 'H11', ref: '§4.2', desc: '403 when every requested topic is denied',
      steps: [
        { op: 'request', path: '/events?topics=a,b', headers: { 'x-t-authorize': 'none' }, expect: { status: 403 } },
      ],
    },
    {
      id: 'H12', ref: '§4.3', desc: 'partial denial opens the stream and names the refused topics in a ~denied frame',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=ok%2Fa,no%2Fb', headers: { 'x-t-authorize': 'prefix:ok/' } },
        {
          op: 'expect-frames', of: 's',
          frames: [OK, 'event: ~denied\ndata: {"topics":["no/b"]}\n\n'],
        },
      ],
    },
    {
      id: 'H13', ref: '§7.2', desc: 'a ~denied frame carries no id, so it cannot advance a client cursor past events it never saw',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=ok%2Fa,no%2Fb', headers: { 'x-t-authorize': 'prefix:ok/' } },
        { op: 'expect-frames', of: 's', frames: [OK, 'event: ~denied\ndata: {"topics":["no/b"]}\n\n'] },
        { op: 'expect-no-id-field', of: 's' },
      ],
    },
    {
      id: 'H14', ref: '§4.3', desc: 'an authorize that throws is a 500 — unknown must never resolve to allowed',
      steps: [
        { op: 'request', path: '/events?topics=t', headers: { 'x-t-authorize': 'throw' }, expect: { status: 500 } },
      ],
    },
    {
      id: 'H15', ref: '§4.3', desc: 'a denied topic receives nothing, even while an allowed one on the same connection is live',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=ok%2Fa,no%2Fb', headers: { 'x-t-authorize': 'prefix:ok/' } },
        { op: 'expect-frames', of: 's', frames: [OK, 'event: ~denied\ndata: {"topics":["no/b"]}\n\n'] },
        { op: 'publish', topic: 'no/b', payload: 'secret' },
        { op: 'publish', topic: 'ok/a', payload: 'fine' },
        { op: 'expect-frames', of: 's', frames: ['id: 1000-1\nevent: ok/a\ndata: fine\n\n'] },
      ],
    },
    {
      id: 'H16', ref: '§10', desc: '429 with retry-after once the per-process connection cap is reached',
      app: { maxConnections: 1 },
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        {
          op: 'request', path: '/events?topics=t',
          expect: { status: 429, headers: { 'retry-after': '5' } },
        },
      ],
    },
    {
      id: 'H17', ref: '§10', desc: 'the per-key cap counts by key, so a different user is unaffected',
      app: { maxConnectionsPerKey: 1 },
      steps: [
        { op: 'open', as: 'a', path: '/events?topics=t', headers: { 'x-t-key': 'alice' } },
        { op: 'expect-frames', of: 'a', frames: [OK] },
        {
          op: 'request', path: '/events?topics=t',
          headers: { 'x-t-key': 'alice' }, expect: { status: 429 },
        },
        { op: 'open', as: 'b', path: '/events?topics=t', headers: { 'x-t-key': 'bob' } },
        { op: 'expect-frames', of: 'b', frames: [OK] },
      ],
    },
  ],

  // ---- §4.4 response headers ----------------------------------------------
  //
  // These are the headers that make the difference between a stream that works on a laptop
  // and one that works behind a proxy. Losing them is invisible in development.
  headers: [
    {
      id: 'H18', ref: '§4.4', desc: 'the stream carries the SSE content type and the anti-buffering headers',
      steps: [
        {
          op: 'open', as: 's', path: '/events?topics=t',
          expect: {
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              'x-accel-buffering': 'no',
            },
          },
        },
      ],
    },
    {
      id: 'H19', ref: '§4.4', desc: 'no cursor means the checkpoint header is omitted entirely, not sent empty',
      steps: [
        {
          op: 'open', as: 's', path: '/events?topics=t',
          expect: { status: 200, absentHeaders: ['last-event-id-checkpoint'] },
        },
      ],
    },
    {
      id: 'H20', ref: '§4.4', desc: 'a cursor history still reaches is echoed back verbatim',
      steps: [
        { op: 'publish', topic: 't', payload: 'one' },
        { op: 'publish', topic: 't', payload: 'two' },
        {
          op: 'open', as: 's', path: '/events?topics=t&last_event_id=1000-0',
          expect: { status: 200, headers: { 'last-event-id-checkpoint': '1000-0' } },
        },
      ],
    },
    {
      id: 'H21', ref: '§4.4', desc: 'the cold-start cursor 0-0 on a hub that has evicted nothing is NOT a gap',
      steps: [
        { op: 'publish', topic: 't', payload: 'one' },
        {
          op: 'open', as: 's', path: '/events?topics=t&last_event_id=0-0',
          expect: { status: 200, headers: { 'last-event-id-checkpoint': '0-0' } },
        },
      ],
    },
    {
      id: 'H22', ref: '§4.4', desc: 'a cursor older than retained history reports earliest',
      app: { maxHistoryBytes: 200 },
      steps: [
        { op: 'publish', topic: 't', payload: BIG },
        { op: 'publish', topic: 't', payload: BIG },
        { op: 'publish', topic: 't', payload: BIG },
        {
          op: 'open', as: 's', path: '/events?topics=t&last_event_id=1000-0',
          expect: { status: 200, headers: { 'last-event-id-checkpoint': 'earliest' } },
        },
      ],
    },
    {
      id: 'H23', ref: '§4.1', desc: 'the Last-Event-ID header wins over the query parameter when both are present',
      steps: [
        { op: 'publish', topic: 't', payload: 'one' },
        { op: 'publish', topic: 't', payload: 'two' },
        {
          op: 'open', as: 's', path: '/events?topics=t&last_event_id=1000-0',
          headers: { 'last-event-id': '1000-1' },
          expect: { status: 200, headers: { 'last-event-id-checkpoint': '1000-1' } },
        },
      ],
    },
  ],

  // ---- §4.5 write order on connect ----------------------------------------
  //
  // The order is the product. Each of these describes one instant that a client depends
  // on being described truthfully, and every one of them is reachable only over a socket.
  order: [
    {
      id: 'H24', ref: '§4.5', desc: 'a fresh stream opens with :ok and nothing else',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
      ],
    },
    {
      id: 'H25', ref: '§4.5', desc: 'replay follows :ok, oldest first, and excludes the cursor event itself',
      steps: [
        { op: 'publish', topic: 't', payload: 'one' },
        { op: 'publish', topic: 't', payload: 'two' },
        { op: 'publish', topic: 't', payload: 'three' },
        { op: 'open', as: 's', path: '/events?topics=t&last_event_id=1000-0' },
        {
          op: 'expect-frames', of: 's',
          frames: [
            OK,
            'id: 1000-1\nevent: t\ndata: two\n\n',
            'id: 1000-2\nevent: t\ndata: three\n\n',
          ],
        },
      ],
    },
    {
      id: 'H26', ref: '§4.5', desc: 'the full opening sequence is :ok, then ~denied, then ~gap, then replay',
      app: { maxHistoryBytes: 200 },
      steps: [
        // Three big frames into a one-frame ring, so eviction reaches 1000-1 and a cursor
        // at 1000-0 is genuinely behind what history still holds.
        { op: 'publish', topic: 'ok/a', payload: BIG },
        { op: 'publish', topic: 'ok/a', payload: BIG },
        { op: 'publish', topic: 'ok/a', payload: BIG },
        {
          op: 'open', as: 's', path: '/events?topics=ok%2Fa,no%2Fb&last_event_id=1000-0',
          headers: { 'x-t-authorize': 'prefix:ok/' },
        },
        {
          op: 'expect-frames', of: 's',
          frames: [
            OK,
            'event: ~denied\ndata: {"topics":["no/b"]}\n\n',
            'event: ~gap\ndata: {"reason":"history-truncated","topics":["ok/a"]}\n\n',
            `id: 1000-2\nevent: ok/a\ndata: ${BIG}\n\n`,
          ],
        },
      ],
    },
    {
      id: 'H27', ref: '§7.1', desc: 'a ~gap frame carries no id, so a client cannot mistake it for an event it has now seen',
      app: { maxHistoryBytes: 200 },
      steps: [
        { op: 'publish', topic: 't', payload: BIG },
        { op: 'publish', topic: 't', payload: BIG },
        { op: 'publish', topic: 't', payload: BIG },
        { op: 'open', as: 's', path: '/events?topics=t&last_event_id=1000-0' },
        { op: 'expect-frame-matching', of: 's', contains: '"reason":"history-truncated"' },
        { op: 'expect-no-id-field', of: 's' },
      ],
    },
    {
      id: 'H28', ref: '§6.1', desc: 'a payload containing a blank line cannot inject a field over the wire',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=chat' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'publish', topic: 'chat', payload: 'hello\n\nevent: ~gap\ndata: forged' },
        {
          op: 'expect-frames', of: 's',
          frames: ['id: 1000-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n'],
        },
      ],
    },
    {
      id: 'H29', ref: '§6.0', desc: 'an origin reaches the wire as its own field, between event and data',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'publish', topic: 't', payload: 'v', origin: 'tab-7' },
        { op: 'expect-frames', of: 's', frames: ['id: 1000-0\nevent: t\norigin: tab-7\ndata: v\n\n'] },
      ],
    },
    {
      id: 'H30', ref: '§4.5', desc: 'a live publish reaches only subscribers of that topic',
      steps: [
        { op: 'open', as: 'a', path: '/events?topics=x' },
        { op: 'open', as: 'b', path: '/events?topics=y' },
        { op: 'expect-frames', of: 'a', frames: [OK] },
        { op: 'expect-frames', of: 'b', frames: [OK] },
        { op: 'publish', topic: 'x', payload: 'for-a' },
        { op: 'expect-frames', of: 'a', frames: ['id: 1000-0\nevent: x\ndata: for-a\n\n'] },
        { op: 'expect-frames', of: 'b', frames: [] },
      ],
    },
  ],

  // ---- §4.5 the backplane window ------------------------------------------
  //
  // The window that only exists once replay is fetched over a network: the subscriber is
  // registered — and therefore writable, droppable and countable — while the response
  // still has no headers on it. Three separate bugs lived here, each of which silently
  // produced a subscriber that received nothing.
  window: [
    {
      id: 'H31', ref: '§4.5', desc: 'an event published during backplane replay is delivered exactly once, after the headers',
      app: { backplaneDelayMs: 120 },
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t', headers: { 'last-event-id': '1000-0' }, await: false },
        // Lands inside the atomic block, while the subscriber is registered but the
        // response has not been written to yet.
        { op: 'sleep', ms: 40 },
        { op: 'publish', topic: 't', payload: 'during' },
        { op: 'await-open', of: 's', expect: { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } } },
        { op: 'expect-frame-matching', of: 's', contains: 'data: during' },
        { op: 'expect-frame-count', of: 's', matching: 'data: during', count: 1 },
      ],
    },
    {
      id: 'H32', ref: '§6.2', desc: 'a keepalive tick during replay does not steal the response headers',
      app: { backplaneDelayMs: 120, keepAliveMs: 40 },
      steps: [
        // An already-open connection, purely to start the shared keepalive interval.
        { op: 'open', as: 'idle', path: '/events?topics=x' },
        { op: 'open', as: 's', path: '/events?topics=t', headers: { 'last-event-id': '1000-0' } },
        {
          op: 'expect-headers', of: 's',
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'x-accel-buffering': 'no',
            'last-event-id-checkpoint': '1000-0',
          },
        },
      ],
    },
    {
      id: 'H33', ref: '§8.2', desc: 'a client aborting during replay leaks no subscriber',
      app: { backplaneDelayMs: 100 },
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t', headers: { 'last-event-id': '1000-0' }, await: false },
        { op: 'sleep', ms: 30 },
        { op: 'abort', of: 's' },
        { op: 'sleep', ms: 200 },
        { op: 'expect-stats', connections: 0 },
      ],
    },
  ],

  // ---- §5 the cursor endpoint ---------------------------------------------
  cursor: [
    {
      id: 'H34', ref: '§5', desc: 'the cursor endpoint reports 0-0 before anything is published',
      steps: [{ op: 'get-cursor', expect: '0-0' }],
    },
    {
      id: 'H35', ref: '§5', desc: 'the cursor endpoint reports the newest assigned id',
      steps: [
        { op: 'publish', topic: 't', payload: 'one' },
        { op: 'publish', topic: 't', payload: 'two' },
        { op: 'get-cursor', expect: '1000-1' },
      ],
    },
    {
      id: 'H36', ref: '§5', desc: 'the cursor endpoint is not cached — a stale one reopens the cold-start window it exists to close',
      steps: [{ op: 'request', path: '/events/cursor', expect: { status: 200, headers: { 'cache-control': 'no-store' } } }],
    },
  ],

  // ---- §6.2 / §8.2 liveness and teardown ----------------------------------
  lifecycle: [
    {
      id: 'H37', ref: '§6.2', desc: 'an idle stream receives keepalive comments',
      app: { keepAliveMs: 40 },
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'expect-frame-matching', of: 's', contains: ':ka' },
      ],
    },
    {
      id: 'H38', ref: '§6.2', desc: 'a keepalive is a comment, so it carries no id and cannot move a cursor',
      app: { keepAliveMs: 40 },
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'expect-frame-matching', of: 's', contains: ':ka' },
        { op: 'expect-no-id-field', of: 's' },
      ],
    },
    {
      id: 'H39', ref: '§8.2', desc: 'aborting a stream removes its subscriber',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'expect-stats', connections: 1 },
        { op: 'abort', of: 's' },
        { op: 'sleep', ms: 150 },
        { op: 'expect-stats', connections: 0 },
      ],
    },
    {
      id: 'H40', ref: '§10', desc: 'a deliberate eviction is attributed to the eviction, not to the client close it causes',
      steps: [
        { op: 'open', as: 's', path: '/events?topics=t', headers: { 'x-t-key': 'alice' } },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'disconnect', key: 'alice' },
        { op: 'sleep', ms: 150 },
        // A total filed under the wrong reason sends whoever reads it after the wrong
        // problem entirely.
        { op: 'expect-stats', connections: 0, closed: { evicted: 1, client: 0 } },
      ],
    },
    {
      id: 'H41', ref: '§10', desc: 'rejections are bucketed by cause rather than lumped together',
      app: { maxConnections: 1 },
      steps: [
        { op: 'request', path: '/events', expect: { status: 400 } },
        { op: 'request', path: '/events?topics=t', headers: { 'x-t-authorize': 'none' }, expect: { status: 403 } },
        { op: 'open', as: 's', path: '/events?topics=t' },
        { op: 'expect-frames', of: 's', frames: [OK] },
        { op: 'request', path: '/events?topics=t', expect: { status: 429 } },
        {
          op: 'expect-stats',
          rejected: { 'bad-request': 1, unauthorized: 1, 'over-capacity': 1 },
        },
      ],
    },
  ],
}

writeFileSync(new URL('./scenarios.json', import.meta.url), JSON.stringify(scenarios, null, 2) + '\n')

const groups = Object.entries(scenarios).filter(([, v]) => Array.isArray(v))
const total = groups.reduce((n, [, v]) => n + v.length, 0)
console.log(
  `scenarios.json written — ${total} scenarios across ${groups.length} groups: ` +
    groups.map(([k, v]) => `${v.length} ${k}`).join(', '),
)
