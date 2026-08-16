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
  version: '0.1',
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
  ],
}

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n')
console.log(
  `vectors.json written — ${vectors.encode.length} encode, ${vectors.topic.length} topic, ` +
  `${vectors.origin.length} origin, ${vectors.idOrder.length} id-order, ` +
  `${vectors.monotonic.length} monotonic, ${vectors.checkpoint.length} checkpoint`
)
