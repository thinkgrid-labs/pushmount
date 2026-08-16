// Emits vectors.json.
//
// Every expected value below is written out from PROTOCOL.md by hand. None of it is
// captured from a running implementation — a corpus recorded from an implementation
// only proves that implementation is self-consistent, and would have enshrined the
// UTF-16 topic-length bug that T15 exists to catch.
//
// Node is used only to build the long repeated strings. Regenerate with:
//   node build-vectors.mjs

import { writeFileSync } from 'node:fs'

const x255 = 'x'.repeat(255)
const x256 = 'x'.repeat(256)
const jp86 = '日'.repeat(86)   // 86 UTF-16 units, 258 UTF-8 bytes
const x64 = 'x'.repeat(64)
const x65 = 'x'.repeat(65)
const jp22 = '日'.repeat(22)   // 22 UTF-16 units, 66 UTF-8 bytes

const vectors = {
  // Bumped whenever a vector's expected value changes or a group is added, so an adapter
  // can report which corpus it passes. 0.2 added `idParse` and `append`, and narrowed the
  // id bound to 2^53-1 (DECISIONS.md D9). 0.3 added `buffer` (D10).
  version: '0.3',
  spec: 'PROTOCOL.md',
  note:
    'Frames are written as JSON strings; the wire bytes are their UTF-8 encoding. ' +
    'All line terminators are LF. Implementations MUST agree byte-for-byte.',

  // ---- §6.1 frame encoding -------------------------------------------------
  encode: [
    {
      id: 'E1', ref: '§12 V1', desc: 'simple event',
      ms: 1755083412346, seq: 0, topic: 'org/42/orders', payload: '{"id":"ord_918"}',
      frame: 'id: 1755083412346-0\nevent: org/42/orders\ndata: {"id":"ord_918"}\n\n',
    },
    {
      id: 'E2', ref: '§12 V2', desc: 'payload containing a blank line cannot inject a field',
      ms: 1, seq: 0, topic: 'chat', payload: 'hello\n\nevent: ~gap\ndata: forged',
      frame: 'id: 1-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n',
    },
    {
      id: 'E3', ref: '§12 V3', desc: 'empty payload is one empty data line',
      ms: 1, seq: 0, topic: 'ping', payload: '',
      frame: 'id: 1-0\nevent: ping\ndata: \n\n',
    },
    {
      id: 'E4', ref: '§6.1', desc: 'bare CR is a segment boundary',
      ms: 1, seq: 0, topic: 't', payload: 'a\rb',
      frame: 'id: 1-0\nevent: t\ndata: a\ndata: b\n\n',
    },
    {
      id: 'E5', ref: '§6.1', desc: 'CRLF is one boundary, not two',
      ms: 1, seq: 0, topic: 't', payload: 'a\r\nb',
      frame: 'id: 1-0\nevent: t\ndata: a\ndata: b\n\n',
    },
    {
      id: 'E6', ref: '§6.1', desc: 'mixed CRLF, CR and LF in one payload',
      ms: 1, seq: 0, topic: 't', payload: 'a\r\nb\rc\nd',
      frame: 'id: 1-0\nevent: t\ndata: a\ndata: b\ndata: c\ndata: d\n\n',
    },
    {
      id: 'E7', ref: '§6.1', desc: 'trailing newline yields a trailing empty segment',
      ms: 1, seq: 0, topic: 't', payload: 'a\n',
      frame: 'id: 1-0\nevent: t\ndata: a\ndata: \n\n',
    },
    {
      id: 'E8', ref: '§6.1', desc: 'leading newline yields a leading empty segment',
      ms: 1, seq: 0, topic: 't', payload: '\na',
      frame: 'id: 1-0\nevent: t\ndata: \ndata: a\n\n',
    },
    {
      id: 'E9', ref: '§6.1', desc: 'a payload of only newlines is three empty segments',
      ms: 1, seq: 0, topic: 't', payload: '\n\n',
      frame: 'id: 1-0\nevent: t\ndata: \ndata: \ndata: \n\n',
    },
    {
      id: 'E10', ref: '§6', desc: 'multibyte payload passes through unchanged',
      ms: 1, seq: 0, topic: 'unicode', payload: '{"name":"日本語 — émoji 🚀"}',
      frame: 'id: 1-0\nevent: unicode\ndata: {"name":"日本語 — émoji 🚀"}\n\n',
    },
    {
      id: 'E11', ref: '§2', desc: 'large ms and seq render without separators or exponent',
      ms: 9007199254740991, seq: 12345, topic: 't', payload: 'x',
      frame: 'id: 9007199254740991-12345\nevent: t\ndata: x\n\n',
    },
    {
      id: 'E12', ref: '§3', desc: 'tilde inside a topic is legal and is not escaped',
      ms: 1, seq: 0, topic: 'a~b', payload: 'v',
      frame: 'id: 1-0\nevent: a~b\ndata: v\n\n',
    },
    {
      id: 'E13', ref: '§6.0', desc: 'origin is emitted between event and data',
      ms: 1, seq: 0, topic: 't', payload: 'v', origin: '7f3a1c0e',
      frame: 'id: 1-0\nevent: t\norigin: 7f3a1c0e\ndata: v\n\n',
    },
    {
      id: 'E14', ref: '§6.0', desc: 'an empty origin is omitted, not emitted empty',
      ms: 1, seq: 0, topic: 't', payload: 'v', origin: '',
      frame: 'id: 1-0\nevent: t\ndata: v\n\n',
    },
    {
      id: 'E15', ref: '§6.0',
      desc: 'a frame with no origin is byte-identical to one from before the field existed',
      ms: 1, seq: 0, topic: 't', payload: 'v',
      frame: 'id: 1-0\nevent: t\ndata: v\n\n',
    },
    {
      id: 'E16', ref: '§6.0',
      desc: 'origin and a segmented payload keep their order: id, event, origin, data',
      ms: 1, seq: 0, topic: 't', payload: 'a\nb', origin: 'tab-1',
      frame: 'id: 1-0\nevent: t\norigin: tab-1\ndata: a\ndata: b\n\n',
    },
  ],

  // ---- §6.0 origin validation ---------------------------------------------
  //
  // The same shape as the topic rules, and here for the same reason: an origin is
  // written into a frame, so a control character in it forges the next one. It differs
  // in coming from whichever client issued the write, which makes it the more exposed
  // of the two fields.
  origin: [
    { id: 'O1', origin: '7f3a1c0e', valid: true, desc: 'ordinary opaque token' },
    { id: 'O2', origin: 'a', valid: true, desc: 'one byte is the minimum' },
    { id: 'O3', origin: x64, valid: true, desc: '64 bytes is the maximum' },
    { id: 'O4', origin: x65, valid: false, desc: '65 bytes is one too many' },
    { id: 'O5', origin: '', valid: false, desc: 'empty is absent, and absent is not a value' },
    {
      id: 'O6', origin: 'a\nid: 1-0', valid: false,
      desc: 'LF would end the frame and forge the next one',
    },
    { id: 'O7', origin: 'a\rb', valid: false, desc: 'bare CR is a segment boundary too' },
    { id: 'O8', origin: 'a\u0000b', valid: false, desc: 'NUL is a control character' },
    { id: 'O9', origin: 'a\u007fb', valid: false, desc: 'DEL is a control character' },
    {
      id: 'O10', origin: jp22, valid: false,
      desc: '22 characters but 66 UTF-8 bytes — bytes, not code units (cf. T15)',
    },
    {
      id: 'O11', origin: '~tilde', valid: true,
      desc: 'tilde is reserved for topics only; an origin is never a frame name',
    },
  ],

  // ---- §3 topic validation -------------------------------------------------
  topic: [
    { id: 'T1',  topic: 'org/42/orders', valid: true,  desc: 'ordinary hierarchical topic' },
    { id: 'T2',  topic: 'a',             valid: true,  desc: 'one byte is the minimum' },
    { id: 'T3',  topic: x255,            valid: true,  desc: '255 bytes is the maximum' },
    { id: 'T4',  topic: x256,            valid: false, desc: '256 bytes exceeds the maximum' },
    { id: 'T5',  topic: '',              valid: false, desc: 'empty is rejected' },
    { id: 'T6',  topic: '~',             valid: false, desc: 'bare reserved prefix' },
    { id: 'T7',  topic: '~gap',          valid: false, desc: 'forging a control frame name' },
    { id: 'T8',  topic: 'a~b',           valid: true,  desc: 'tilde is reserved only in first position' },
    { id: 'T9',  topic: 'a\nb',          valid: false, desc: 'LF would split the frame' },
    { id: 'T10', topic: 'a\rb',          valid: false, desc: 'CR would split the frame' },
    { id: 'T11', topic: 'a\u0000b',      valid: false, desc: 'NUL truncates the field in any C-based proxy on the path' },
    { id: 'T12', topic: 'a\u001Fb',      valid: false, desc: 'other C0 control' },
    { id: 'T13', topic: 'a\u007Fb',      valid: false, desc: 'DEL is excluded alongside the C0 controls' },
    { id: 'T14', topic: '日本語',         valid: true,  desc: 'multibyte topic, 9 bytes' },
    {
      id: 'T15', topic: jp86, valid: false,
      desc: 'THE LENGTH LIMIT IS BYTES, NOT CHARACTERS — 86 characters, 258 UTF-8 bytes. ' +
            'An implementation measuring String.length (UTF-16 units) accepts this and diverges.',
    },
    { id: 'T16', topic: '🚀',            valid: true,  desc: 'astral plane, 4 bytes, 2 UTF-16 units' },
  ],

  // ---- §2.1 id comparison --------------------------------------------------
  idOrder: [
    { id: 'O1', a: [1755083412345, 7],  b: [1755083412345, 10], cmp: -1, desc: 'seq 7 < seq 10 — a string compare gets this backwards' },
    { id: 'O2', a: [1755083412345, 10], b: [1755083412346, 0],  cmp: -1, desc: 'ms dominates seq' },
    { id: 'O3', a: [1755083412345, 7],  b: [1755083412345, 7],  cmp: 0,  desc: 'identical ids compare equal, so resuming at the cursor replays nothing' },
    { id: 'O4', a: [2, 0],              b: [1, 999],            cmp: 1,  desc: 'larger ms wins regardless of seq' },
  ],

  // ---- §2.1 id parsing -----------------------------------------------------
  //
  // Which strings are ids at all. This reaches the wire from two directions — a client's
  // `Last-Event-ID`, and the id a backplane assigns — and §2.1's canonical form is
  // exactly the kind of rule each language gets wrong in its own way: one accepts leading
  // zeros because it calls `parseInt`, another accepts `1e5` because it calls `Number`,
  // a third accepts `" 1-0"` because its integer parser skips whitespace.
  //
  // The failure is not a rejected request. It is two implementations disagreeing about
  // which event an id NAMES: if `01-0` parses as `1-0` in one process and is refused in
  // another, the same cursor resumes from two different places.
  idParse: [
    { id: 'P1', raw: '0-0', valid: true, desc: 'the cold-start cursor §5 hands out must parse' },
    { id: 'P2', raw: '1755083412345-7', valid: true, desc: 'an ordinary id' },
    { id: 'P3', raw: '1755083412345-0', valid: true, desc: 'a zero seq is not a padded zero' },
    { id: 'P4', raw: '', valid: false, desc: 'empty is not an id' },
    { id: 'P5', raw: '1', valid: false, desc: 'no separator' },
    { id: 'P6', raw: '1-', valid: false, desc: 'an empty seq half' },
    { id: 'P7', raw: '-0', valid: false, desc: 'an empty ms half' },
    { id: 'P8', raw: '01-0', valid: false, desc: 'leading zeros are not canonical — parseInt accepts them and two processes then disagree about which event this names' },
    { id: 'P9', raw: '1-00', valid: false, desc: 'leading zeros in the seq half, same reason' },
    { id: 'P10', raw: '1e5-0', valid: false, desc: 'exponent notation — Number() accepts it, §2 does not' },
    { id: 'P11', raw: '+1-0', valid: false, desc: 'an explicit plus sign — accepted by several languages\' integer parsers' },
    { id: 'P12', raw: '1.0-0', valid: false, desc: 'a decimal point' },
    { id: 'P13', raw: ' 1-0', valid: false, desc: 'leading whitespace — many integer parsers skip it silently' },
    { id: 'P14', raw: '1-0 ', valid: false, desc: 'trailing whitespace' },
    { id: 'P15', raw: 'a-b', valid: false, desc: 'not digits at all' },
    { id: 'P16', raw: '-1-0', valid: false, desc: 'a negative ms cannot be an id' },
    // The bound §2 places on both halves. This is a real divergence the corpus caught:
    // the spec said "unsigned 64-bit", which no JavaScript host can represent, so the
    // TypeScript core rejected these while the Rust core accepted them — the same cursor
    // string naming two different events depending on who received it. See DECISIONS.md D9.
    { id: 'P17', raw: '9007199254740991-0', valid: true, desc: '2^53-1 is the largest ms, and it parses' },
    { id: 'P18', raw: '0-9007199254740991', valid: true, desc: '2^53-1 is the largest seq, and it parses' },
    { id: 'P19', raw: '9007199254740992-0', valid: false, desc: '2^53 — an f64 cannot distinguish it from its neighbour, so it cannot name one event' },
    { id: 'P20', raw: '0-9007199254740992', valid: false, desc: 'the same bound applies to the seq half' },
    { id: 'P21', raw: '18446744073709551615-0', valid: false, desc: 'u64::MAX — accepted by a naive 64-bit parser, unrepresentable in JavaScript' },
  ],

  // ---- §2.2 monotonicity ---------------------------------------------------
  monotonic: [
    {
      id: 'M1', desc: 'clock regression must not produce a cursor regression',
      nowMs: [1000, 999, 999], expected: ['1000-0', '1000-1', '1000-2'],
    },
    {
      id: 'M2', desc: 'seq resets only when ms actually advances',
      nowMs: [1000, 1000, 1001], expected: ['1000-0', '1000-1', '1001-0'],
    },
    {
      id: 'M3', desc: 'a stalled clock keeps incrementing seq',
      nowMs: [5, 5, 5, 5], expected: ['5-0', '5-1', '5-2', '5-3'],
    },
  ],

  // ---- §4.5 / §7.1 the checkpoint decision ---------------------------------
  //
  // Whether a reconnecting client is told it missed events. Getting this wrong is
  // invisible in both directions and expensive in both: a false `earliest` makes every
  // cold start refetch and trains people to ignore the signal, and a false `echo` is
  // silent staleness, which is the failure this protocol exists to eliminate.
  //
  // The rule these pin down is "was anything evicted that this cursor had not already
  // seen?" — a comparison against the highest id ever DROPPED, not against the oldest
  // id still retained. Frames here are 92 bytes each (`id: 1000-0` + `event: t` +
  // `data:` with 64 bytes of payload), which is what makes the small budgets below
  // trim a predictable number of them.
  checkpoint: [
    {
      id: 'CP1', ref: '§5', desc: 'the cold-start cursor 0-0 on a ring that never trimmed is not a gap',
      maxHistoryBytes: 1048576,
      publishes: [[1000, 't', x64], [1001, 't', x64]],
      cursor: [0, 0], expected: 'echo',
    },
    {
      id: 'CP2', ref: '§4.5', desc: 'a cursor at a retained event replays without a gap',
      maxHistoryBytes: 1048576,
      publishes: [[1000, 't', x64], [1001, 't', x64], [1002, 't', x64]],
      cursor: [1000, 0], expected: 'echo',
    },
    {
      id: 'CP3', ref: '§7.1', desc: 'a cursor below everything the ring evicted is a gap',
      maxHistoryBytes: 100,
      publishes: [[1000, 't', x64], [1001, 't', x64]],
      cursor: [0, 0], expected: 'earliest',
    },
    {
      id: 'CP4', ref: '§7.1', desc: 'a cursor AT the evicted id is not a gap — that event is the one the client holds',
      maxHistoryBytes: 100,
      publishes: [[1000, 't', x64], [1001, 't', x64]],
      cursor: [1000, 0], expected: 'echo',
    },
    {
      id: 'CP5', desc: 'a hub that has published nothing reports no gap',
      maxHistoryBytes: 1048576,
      publishes: [],
      cursor: [0, 0], expected: 'echo',
    },
    {
      id: 'CP6', ref: '§4.1', desc: 'no cursor means the checkpoint header is omitted entirely',
      maxHistoryBytes: 1048576,
      publishes: [[1000, 't', x64]],
      cursor: null, expected: 'absent',
    },
    {
      id: 'CP7', ref: '§7.1', desc: 'an event larger than the whole budget is evicted on arrival and must still report a gap',
      maxHistoryBytes: 10,
      publishes: [[1000, 't', x64]],
      cursor: [0, 0], expected: 'earliest',
    },
    // A cursor can also be unvouchable from the other direction: newer than anything the
    // hub has ever issued. That is what a client resuming across a process restart looks
    // like — the ring is empty and nothing was trimmed, so the eviction rule alone answers
    // "you missed nothing" and everything published before the shutdown is gone with
    // nobody told. Silent staleness, arrived at from the opposite end.
    {
      id: 'CP8', ref: '§7.1', desc: 'a cursor newer than any id the hub has issued is a gap — this is a client resuming across a restart',
      maxHistoryBytes: 1048576,
      publishes: [[1000, 't', x64]],
      cursor: [2000, 0], expected: 'earliest',
    },
    {
      id: 'CP9', ref: '§7.1', desc: 'a cursor exactly at the newest id is not a gap — that is the ordinary case for a caught-up client',
      maxHistoryBytes: 1048576,
      publishes: [[1000, 't', x64]],
      cursor: [1000, 0], expected: 'echo',
    },
    {
      id: 'CP10', ref: '§7.1', desc: 'a real cursor against a hub that has published nothing is a gap, not a fresh start',
      maxHistoryBytes: 1048576,
      publishes: [],
      cursor: [1755083412345, 7], expected: 'earliest',
    },
  ],

  // ---- the externally-assigned-id path -------------------------------------
  //
  // What a backplane needs, and therefore what every multi-worker runtime needs: an
  // event whose id came from a shared sequencer rather than this process's counter.
  //
  // `ops` is applied in order to a fresh hub. Each op emits one frame, and the vector
  // pins both the frames and the cursor afterwards:
  //
  //   ["publish", nowMs, topic, payload, origin]  — the hub assigns the id
  //   ["append",  id,    topic, payload, origin]  — the sequencer assigned it; recorded
  //   ["encode",  id,    topic, payload, origin]  — bytes only, recorded nowhere
  //
  // The cursor is the assertion that matters. `append` must advance it, so a process
  // falling back to local assignment cannot reissue an id another process already spent;
  // `encode` must not, because those events belong to the shared log and recording them
  // here duplicates them into the local ring on every reconnect.
  append: [
    {
      id: 'A1', ref: '§2', desc: 'an appended event carries the sequencer\'s id verbatim — a per-process counter would collide across pods',
      ops: [['append', '1755083412346-4', 't', 'v', null]],
      frames: ['id: 1755083412346-4\nevent: t\ndata: v\n\n'],
      cursor: '1755083412346-4',
    },
    {
      id: 'A2', ref: '§2.2', desc: 'a local publish after an append cannot reissue an id the sequencer already spent',
      ops: [['append', '1000-4', 't', 'v', null], ['publish', 1000, 't', 'w', null]],
      frames: ['id: 1000-4\nevent: t\ndata: v\n\n', 'id: 1000-5\nevent: t\ndata: w\n\n'],
      cursor: '1000-5',
    },
    {
      id: 'A3', ref: '§2.2', desc: 'an out-of-order append never drags the cursor backwards — replay after a reconnect delivers older ids',
      ops: [['append', '1000-4', 't', 'v', null], ['append', '999-0', 't', 'w', null]],
      frames: ['id: 1000-4\nevent: t\ndata: v\n\n', 'id: 999-0\nevent: t\ndata: w\n\n'],
      cursor: '1000-4',
    },
    {
      id: 'A4', ref: '§6.0', desc: 'an origin survives the append path, so a tab still skips its own write when the event crossed a backplane',
      ops: [['append', '1-0', 't', 'v', 'tab-7']],
      frames: ['id: 1-0\nevent: t\norigin: tab-7\ndata: v\n\n'],
      cursor: '1-0',
    },
    {
      id: 'A5', ref: '§6.0', desc: 'an empty origin is absent on the append path too, byte-identically',
      ops: [['append', '1-0', 't', 'v', '']],
      frames: ['id: 1-0\nevent: t\ndata: v\n\n'],
      cursor: '1-0',
    },
    {
      id: 'A6', ref: '§6.1', desc: 'the injection defence holds on the append path — a backplane payload is no more trusted than a local one',
      ops: [['append', '1-0', 'chat', 'hello\n\nevent: ~gap\ndata: forged', null]],
      frames: ['id: 1-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n'],
      cursor: '1-0',
    },
    {
      id: 'A7', ref: '§4.5', desc: 'encode emits the frame publish would have, and records nothing — the cursor must not move',
      ops: [['encode', '5000-2', 't', 'v', null]],
      frames: ['id: 5000-2\nevent: t\ndata: v\n\n'],
      cursor: '0-0',
    },
    {
      id: 'A8', ref: '§4.5', desc: 'encode after an append leaves the appended cursor untouched — replay from a shared log must not rewrite local state',
      ops: [['append', '1000-0', 't', 'v', null], ['encode', '9999-9', 't', 'w', null]],
      frames: ['id: 1000-0\nevent: t\ndata: v\n\n', 'id: 9999-9\nevent: t\ndata: w\n\n'],
      cursor: '1000-0',
    },
    {
      id: 'A9', ref: '§2', desc: 'append and publish agree byte-for-byte for the same id, so a frame\'s shape never depends on whether a backplane is configured',
      ops: [['publish', 1000, 't', 'v', 'tab-7'], ['append', '1000-1', 't', 'v', 'tab-7']],
      frames: [
        'id: 1000-0\nevent: t\norigin: tab-7\ndata: v\n\n',
        'id: 1000-1\nevent: t\norigin: tab-7\ndata: v\n\n',
      ],
      cursor: '1000-1',
    },
  ],

  // ---- §8.2 backpressure ---------------------------------------------------
  //
  // Whether a subscriber that cannot drain its socket is dropped. Half the loss story:
  // a subscriber left to starve diverges silently, which is the failure §0 exists to
  // prevent, and one dropped too eagerly is a reconnect storm.
  //
  // Two ways to feed the same counter, because the absolute depth Node reads off
  // `res.writableLength` is a question ASGI, net/http and Swoole cannot answer — they
  // suspend instead of exposing a queue. Both must reach the same verdict from the same
  // outstanding total, or identical traffic drops a subscriber in one language and not
  // another. `ops` is applied in order to one subscriber on a fresh hub:
  //
  //   ["buffer",  n]   absolute outstanding depth
  //   ["sent",    n]   n bytes handed to the transport
  //   ["flushed", n]   n bytes confirmed drained
  //
  // `expected` is the verdict after each op.
  buffer: [
    {
      id: 'B1', ref: '§8.2', desc: 'the cap is exclusive — a subscriber exactly at its budget is doing nothing wrong',
      maxBufferBytes: 100,
      ops: [['buffer', 99], ['buffer', 100], ['buffer', 101]],
      expected: ['ok', 'ok', 'slow-consumer'],
    },
    {
      id: 'B2', ref: '§8.2', desc: 'sent deltas accumulate to the same verdict the absolute depth would give',
      maxBufferBytes: 100,
      ops: [['sent', 60], ['sent', 40], ['sent', 1]],
      expected: ['ok', 'ok', 'slow-consumer'],
    },
    {
      id: 'B3', ref: '§8.2', desc: 'a flush brings a slow consumer back under the cap — draining is recovery, not a one-way door',
      maxBufferBytes: 100,
      ops: [['sent', 150], ['flushed', 100], ['sent', 40]],
      expected: ['slow-consumer', 'ok', 'ok'],
    },
    {
      id: 'B4', ref: '§8.2', desc: 'a flush for bytes never sent saturates at zero rather than underflowing to a huge total',
      maxBufferBytes: 100,
      ops: [['sent', 10], ['flushed', 9999], ['sent', 50]],
      expected: ['ok', 'ok', 'ok'],
    },
    {
      id: 'B5', ref: '§8.2', desc: 'an absolute report of zero clears the outstanding count',
      maxBufferBytes: 100,
      ops: [['buffer', 500], ['buffer', 0]],
      expected: ['slow-consumer', 'ok'],
    },
    {
      id: 'B6', ref: '§8.2', desc: 'a subscriber stays slow while it stays over — the verdict describes now, not a latch',
      maxBufferBytes: 100,
      ops: [['sent', 200], ['sent', 10], ['flushed', 5]],
      expected: ['slow-consumer', 'slow-consumer', 'slow-consumer'],
    },
    {
      id: 'B7', ref: '§8.2', desc: 'zero-byte reports are inert on both styles',
      maxBufferBytes: 100,
      ops: [['sent', 0], ['flushed', 0], ['buffer', 0]],
      expected: ['ok', 'ok', 'ok'],
    },
  ],
}

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n')
console.log(
  `vectors.json written — ${vectors.encode.length} encode, ${vectors.topic.length} topic, ` +
  `${vectors.origin.length} origin, ${vectors.idOrder.length} id-order, ` +
  `${vectors.idParse.length} id-parse, ${vectors.monotonic.length} monotonic, ` +
  `${vectors.checkpoint.length} checkpoint, ${vectors.append.length} append, ` +
  `${vectors.buffer.length} buffer`
)
