# aghoz wire protocol

**Version:** 0.1 (draft) · **Status:** normative · **Last updated:** 13 August 2026

This document is the authoritative definition of the aghoz wire format. Where this
document and any implementation disagree, this document is correct and the implementation
has a bug.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in
RFC 2119.

---

## 0. Scope and a naming rule

The protocol is **two endpoints and one response header**. Everything below fits in that.

**The product name never appears on the wire.** No header, event name, field name, query
parameter or reserved token contains "aghoz". This is deliberate and permanent: it
means the name remains a rename, and it means a second implementation can speak this
protocol without adopting our branding. A conformance test asserts it.

**Not in this protocol.** There is no client-to-server messaging. The client never sends
anything but the two requests below. Writes go through the application's existing API.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **hub** | The in-process object holding recent events and open subscribers. |
| **event** | One published item: an id, a topic, and a payload. |
| **topic** | An opaque byte string a subscriber matches on. |
| **cursor** | An event id a client presents to resume from. |
| **history** | The hub's bounded ring of recent events, oldest to newest. |
| **subscriber** | One open response, holding one or more topics. |
| **gap** | A period during which a subscriber provably missed events. |

---

## 2. Event ids

An event id is `<ms>-<seq>`:

- `<ms>` — Unix milliseconds, decimal, no leading zeros.
- `<seq>` — a counter within that millisecond, decimal, no leading zeros, starting at `0`.

Both are unsigned 64-bit. Example: `1755083412345-7`.

### 2.1 Comparison

Ids MUST be compared by parsing both halves as integers and comparing `ms` first, then
`seq`. Ids MUST NOT be compared as whole strings (`"1755083412345-10"` sorts before
`"1755083412345-7"` lexicographically, which is wrong) and MUST NOT be parsed as a single
number.

### 2.2 Monotonicity

The hub MUST NOT ever assign an id less than or equal to one it has already assigned.
If the system clock moves backwards or does not advance, the hub MUST reuse the last
`<ms>` and increment `<seq>`. Wall-clock regression is a real occurrence and MUST NOT be
observable as a cursor regression.

### 2.3 Why this shape

Ownership of id assignment moves to the backplane in v0.3 (Redis, Postgres). The *format*
is what browsers have already deployed by then, so it is fixed now. This shape is issuable
by a single process, by Redis, and by a Postgres sequence without changing the meaning of
"newer than the cursor."

---

## 3. Topics

A topic MUST:

- be valid UTF-8, between 1 and 255 bytes inclusive;
- contain no C0 control character (`U+0000`–`U+001F`) and no `U+007F`;
- not begin with `~` (`U+007E`).

Topics are compared **byte-exactly**. There are no wildcards or patterns in v0.1.

The protocol assigns no meaning to any character within a topic. Applications are
encouraged to use `/`-delimited hierarchies (`org/42/orders`) because prefix-based
`authorize` callbacks read well, but the hub does not parse them.

### 3.1 Why the exclusions

The control characters are a forgery vector: SSE is line-oriented, so a topic containing
LF would let a publisher inject `event:` and `id:` lines into every subscriber's stream.

The `~` prefix is reserved for control frames (§7). Without this rule, publishing to a
topic named `~gap` would forge a data-loss notification for every connected client — the
same attack through a different field.

A hub MUST reject an invalid topic at `publish` time, not at encode time.

---

## 4. Endpoint 1 — the stream

```
GET <mount-path>
```

The mount path is chosen by the host application (`/events` by convention). The endpoint
is mounted inside the host application, after its authentication middleware, so the
request carries whatever credentials that application already uses. The protocol defines
no authentication of its own.

### 4.1 Request

**Query parameters**

| Parameter | Required | Meaning |
|---|---|---|
| `topics` | yes | Comma-separated list of percent-encoded topics. |
| `last_event_id` | no | Cursor, when the header cannot be set. |

Each topic MUST be percent-encoded individually and then joined with `,` (U+002C).
Topics may legally contain commas, so the server MUST percent-decode each element after
splitting, never before.

The encoded `topics` value SHOULD NOT exceed 4096 bytes. Common proxy configurations
(nginx's default `large_client_header_buffers`) reject request lines beyond 8 KB, and
exceeding it produces a failure that looks like a server bug.

**Request headers**

| Header | Required | Meaning |
|---|---|---|
| `Accept: text/event-stream` | SHOULD | |
| `Last-Event-ID` | no | Cursor. |

If both `Last-Event-ID` and `last_event_id` are present and differ, the server MUST use
the header. A client sending both with different values has a bug.

> **Implementation note.** Whether `Last-Event-ID` can be set as a request header from
> `fetch` in every target browser is verified empirically before the client is written.
> `last_event_id` exists so the answer does not gate the protocol.

### 4.2 Response status

| Status | When |
|---|---|
| `200` | The stream opens. Sent even if *some* requested topics were denied. |
| `400` | `topics` missing or empty; a topic violates §3; a cursor violates §2. |
| `403` | **Every** requested topic was denied by `authorize`. |
| `429` | A connection limit was exceeded. MUST include `Retry-After`. |

`401` is never sent by aghoz. Authentication is the host application's middleware,
which runs first.

### 4.3 Partial denial

`403` is correct only when nothing was authorized. When at least one topic is authorized
and at least one is not, the server MUST return `200`, subscribe the authorized topics,
and emit a `~denied` control frame (§7.2) naming the rejected ones.

This is the one place the protocol deliberately does not fail closed at the connection
level, and the reason is structural: a single connection multiplexes every topic in the
application (§9.1). Rejecting the whole connection because one component asked for one
forbidden topic would take down live updates for the entire page, and would keep taking
them down until the client reconnected. Denial stays loud — it is a frame the application
receives, not a silent filter — without coupling unrelated components.

### 4.4 Response headers

The server MUST send:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

and, on HTTP/1.1 only, `Connection: keep-alive`.

`no-transform` prevents compression middleware and intermediary proxies from buffering the
stream. `X-Accel-Buffering: no` does the same for nginx. Both are load-bearing; a stream
that works locally and hangs in staging is almost always one of these two.

The server MUST flush headers before writing any body byte, MUST disable Nagle's algorithm
on the socket, and MUST clear any socket idle timeout.

**`last-event-id-checkpoint`** — sent if and only if the request carried a cursor:

| Value | Meaning |
|---|---|
| the cursor, echoed | History reaches back to the cursor. Nothing was missed. |
| `earliest` | History no longer reaches the cursor. Events were missed. |

Header names are case-insensitive; HTTP/2 lowercases them regardless.

This header is the reason the client cannot be built on `EventSource`, which exposes no
response headers to JavaScript. The server knows whether it can honour a cursor before it
writes a single body byte, so the head is the honest place to say so.

### 4.5 Write order on connect

The server MUST perform these steps in this order:

1. Determine the checkpoint value and write response headers.
2. **Register the subscriber.**
3. Snapshot the replay set.
4. Write `:ok`.
5. Write `~denied`, if any topic was denied.
6. Write `~gap`, if the checkpoint was `earliest`.
7. Write replayed events, oldest to newest.
8. Write live events as they are published.

Steps 1–3 MUST be atomic with respect to publishing. If a publish can interleave between
them, the checkpoint decision can be made against a history that is trimmed before the
snapshot is taken, and a real gap goes unreported — the exact silent staleness this
protocol exists to eliminate.

Registering before snapshotting (2 before 3) can deliver one event twice. That is the
intended trade: clients dedupe by id (§9.2), so a duplicate is a rendering no-op, whereas
the reverse order drops anything published between the two steps and nothing fails.

### 4.6 Authorization lifetime

Authorization is established once, by §4.3, and a stream then outlives the request that
established it. This is a real difference from the polling such a stream replaces, where
every request re-authorized, and implementations MUST NOT present a connection's
authorization as continuously verified.

A server MAY re-check authorization on a live connection at any time. When a re-check
fails, the server MUST close the connection; it MUST NOT continue delivering events for a
topic that is no longer authorized, and it MUST NOT narrow a connection's topic set in
place — there is no frame for "you have lost this topic but keep the rest", and inventing
one would put a second, weaker copy of §4.3's decision on the wire.

Closing is sufficient because it is not the last word. The client reconnects with its
cursor (§9.4) and §4.3 runs again on that request, which answers `403` if nothing is
authorized any more and `200` with a `~denied` frame if only part of it is. The client
therefore learns exactly what it lost, from the authority that decided it, over a path
that already exists.

Clients MUST NOT treat a closed stream as evidence of revocation — it is far more often a
proxy timeout or a deploy — and MUST reconnect per §9.4. A client whose reconnection is
refused with `403` SHOULD stop and surface that to the application rather than backing off
indefinitely, because retrying cannot change the answer.

---

## 5. Endpoint 2 — the cursor

```
GET <mount-path>/cursor
```

```json
{ "cursor": "1755083412345-7" }
```

Returns the id the hub would assign next, minus nothing — that is, the newest id currently
assigned, or the string `"0-0"` if the hub has published nothing.

### 5.1 Why this exists

Between the moment a page's data is fetched and the moment its stream opens, the client
has no cursor, so the server starts it from *now* and anything published in that window is
lost with no gap reported. On a first page load this is a permanent, silent divergence —
precisely the failure mode this protocol claims to have eliminated.

Applications close the window by reading a cursor at the same time they read their data and
passing it as the stream's initial cursor. Servers SHOULD make this convenient by stamping

```
event-cursor: 1755083412345-7
```

on API and SSR responses via middleware. The header name is deliberately generic (§0).

---

## 6. Frame format

Frames are UTF-8 SSE. A data frame is:

```
id: <event-id>\n
event: <topic>\n
[origin: <origin-id>\n]
data: <segment>\n
[data: <segment>\n ...]
\n
```

Field order MUST be `id`, `event`, `origin` if present, then `data` lines. Frames MUST be
terminated by a blank line. Line terminators MUST be LF (`U+000A`), never CRLF.

The `origin` field is OPTIONAL and MUST be omitted entirely — not emitted empty — when the
publisher supplied none. A frame without an origin is byte-identical to one produced by an
implementation that has never heard of the field, which is what makes this an additive
change rather than a version.

### 6.0 Origin

```
origin: 7f3a1c0e
```

Identifies the client that caused the event, so that client can skip it.

A client that issues a write learns the result twice: once in the write's own HTTP
response, and once over the stream. §9.2's dedupe cannot help — it compares event ids, and
the HTTP response has none — so the tab that acted is the one tab that renders the change
twice, which is both the most visible case and the one most likely to be mistaken for a
bug in the application.

An origin id is opaque to the protocol: the server receives it from the client that issued
the write, by whatever means that write already travelled, and echoes it on the resulting
event. Servers MUST NOT derive it, and MUST NOT treat it as identifying a *user* — it is
neither authenticated nor unique, and a client may send any value at all. It carries no
authority and MUST NOT be used for authorization.

An origin MUST be 1 to 64 bytes of UTF-8, and MUST NOT contain a control character
(`U+0000`–`U+001F` or `U+007F`). A server MUST reject a publish whose origin violates this
rather than sanitising it. The reason is §6.1's: a value containing LF ends the frame, and
what follows parses as a new field — so an unvalidated origin is a forgery primitive
reachable by any client that can issue a write.

Clients receiving a frame whose `origin` equals their own origin id MUST advance their
cursor and MUST NOT deliver the event to handlers. Skipping the cursor update instead
would make every skipped event replay on the next reconnect.

### 6.1 Payload segmentation

The payload MUST be split on every CR, LF or CRLF, producing one or more segments, and
each segment MUST be emitted as its own `data:` line. The receiver rejoins segments with
LF.

A serialiser that emits `data: ${payload}\n\n` is **wrong** and is a forgery vector: a
payload containing a blank line terminates the frame and allows the next line to be parsed
as `event:` or `id:`. This is the same class of bug as §3.1, reached through the payload
instead of the topic, and it is reachable by any user-supplied string that reaches
`publish`.

> **Normalization is lossy, and this is normative.** CR and CRLF within a payload arrive as
> LF. Applications requiring byte-exact payloads MUST encode them; JSON does this
> automatically, which is why non-string payloads are JSON-serialised.

An empty payload produces exactly one empty `data:` line and is delivered as an empty
string.

### 6.2 Comments

```
:ok\n\n     immediately after headers
:ka\n\n     every keep-alive interval (default 20s)
```

`:ok` gives buffering intermediaries a byte to release and confirms to the client that the
stream is live rather than merely connected. `:ka` keeps idle proxies from reaping the
connection. Both MUST be ignored by receivers as content. The keep-alive timer MUST be
cleared on disconnect.

### 6.3 Parsing requirements

A conforming parser MUST handle:

- chunk boundaries falling at any byte offset, including mid-field-name and mid-multibyte-character;
- LF, CR and CRLF line terminators on input, even though this protocol only emits LF;
- comment lines (leading `:`), discarded;
- multi-line `data:`, rejoined with LF;
- an optional single space after the field colon, stripped;
- unknown field names, discarded.

### 6.4 One deliberate deviation from EventSource

A conforming parser MUST dispatch an event whose data is the empty string.

The HTML SSE algorithm does the opposite: it discards an event whose data buffer is
empty, so `data: ` alone produces nothing. But §12 V3 requires `publish(topic, '')` to
be delivered — publishing an empty payload, or a bare signal with no body, is a
legitimate thing to do — so this protocol dispatches whenever any field was seen.

This is only possible because the client owns its parser rather than using
`EventSource`, which is the same reason gap detection is possible at all (§4.4). It is
worth stating explicitly because it is the one place where a reader built on
`EventSource` would silently disagree with a conforming one.

---

## 7. Control frames

Control frames use an `event:` name beginning with `~`. They MUST NOT carry an `id:` field
— they are not part of the event sequence and MUST NOT advance a client's cursor.

Clients MUST ignore unknown control frames whose event name begins with `~`. This is the
protocol's only forward-compatibility hook, and it is what allows control frames to be
added without a version negotiation.

### 7.1 `~gap`

```
event: ~gap
data: {"reason":"history-truncated","topics":["org/42/orders"]}
```

`reason` is `history-truncated` or `slow-consumer`. `topics` is the affected set; for
`slow-consumer` it is the subscriber's entire topic set, because all of them are suspect.

### 7.2 `~denied`

```
event: ~denied
data: {"topics":["org/99/orders"]}
```

Sent at most once per connection, before any replay, when §4.3 applies.

---

## 8. Loss conditions

Two conditions, one client-facing callback.

### 8.1 `history-truncated`

The presented cursor is older than the oldest retained event. Signalled **twice**:
`last-event-id-checkpoint: earliest` in the head, and a `~gap` frame in the body.

The redundancy is intentional. The header is authoritative and arrives before any parsing;
the frame ensures a client that cannot read headers — behind a header-stripping proxy, or a
future implementation built on a different transport — still learns. Clients MUST fire
their gap callback **at most once per connection attempt** even when both arrive.

### 8.2 `slow-consumer`

A subscriber whose queued bytes exceed `maxBufferBytes` is disconnected rather than left
to starve. The server MUST attempt to write `~gap` with reason `slow-consumer` before
closing.

> **This write is best-effort and MUST be documented as such.** The buffer is by definition
> already full, so the frame may never reach the client. The *guaranteed* detection is the
> checkpoint on the client's next connection: it reconnects with its cursor, history has
> moved on, and it receives `earliest`. The `~gap` frame is an optimisation that saves one
> round trip, not the mechanism.

A disconnected subscriber MUST be removed from the registry on **both** the request's and
the response's close events. Listening to only one leaks a subscriber for every tab that
ever connected.

---

## 9. Client requirements

### 9.1 One connection

A client MUST multiplex all topics onto a single connection. Topic-set changes MUST be
debounced so that many components mounting in one render pass produce one connection.

Under HTTP/1.1 this connection consumes one of the browser's six per-origin connections.
Clients SHOULD document this; it disappears under HTTP/2.

### 9.2 Cursor and dedupe

A client MUST track the id of the last data frame it received, reconnect with it, and
discard any received event whose id is not greater than the last id it delivered to the
application (§2.1 comparison). Control frames carry no id and MUST NOT update the cursor.

### 9.3 Topic-set changes

There is no client-to-server channel, so a topic cannot be added to a live connection. On
a topic-set change a client MUST close the connection and reopen it with the new set and
its current cursor.

This is correct by construction — it reuses the replay path that must exist anyway — but
it means topic churn costs a reconnect and a replay scan. Debouncing (§9.1) is what makes
it acceptable. Clients SHOULD enforce a maximum topic count (64 by default) consistent with
§4.1's length guidance.

### 9.4 Reconnection

Exponential backoff with jitter, capped.

Status codes are not all equally retryable, and treating them as one class produces
either a hot loop or a stream that never recovers:

| Status | Client behaviour |
|---|---|
| transport error, or the stream ends | Reconnect after backoff. |
| `429` | Reconnect, honouring `Retry-After` when present, otherwise backoff. |
| `400`, `403` | **Stop.** Report through the error callback and do not retry. |

`400` and `403` are decisions about the request itself — a malformed topic, a malformed
cursor, an unauthorized subscription. Retrying cannot change any of them, and a client
that retries turns a configuration mistake into a request flood against the host
application. Recovery requires the application to subscribe to something different,
which is a new client action rather than a retry.

---

## 10. Limits and defaults

| Setting | Default | Notes |
|---|---|---|
| `keepAliveMs` | 20 000 | Below typical 30–60 s proxy idle timeouts. |
| `maxBufferBytes` | 1 MiB | Per subscriber. Triggers `slow-consumer`. |
| `maxHistoryBytes` | 8 MiB | **Bytes, not events.** A count bound is not a memory bound. |
| `maxTopicBytes` | 255 | Per topic. |
| `maxTopicsPerConnection` | 64 | Keeps the encoded query under §4.1's guidance. |
| `maxConnections` | unlimited | Per process. |
| `maxConnectionsPerKey` | unlimited | Keyed by a caller-supplied function, e.g. user id. |

The two connection limits are unlimited by default but MUST exist. A client stuck in a
reconnect loop otherwise pins file descriptors, and every connection costs a replay scan
on arrival.

---

## 11. Compatibility rules

- Servers MUST ignore unknown query parameters.
- Clients MUST ignore unknown SSE fields.
- Clients MUST ignore unknown `~`-prefixed control frames.
- Clients MUST ignore unknown keys in control-frame JSON.
- There is no version field in v0.1. A breaking change takes a new mount path.

---

## 12. Conformance vectors

Implementations MUST agree byte-for-byte on the following. These are the seed of the
shared corpus that the core, every binding, and the browser parser are all tested against.

**V1 — simple event**

```
publish("org/42/orders", '{"id":"ord_918"}')  at id 1755083412346-0
```
```
id: 1755083412346-0\n
event: org/42/orders\n
data: {"id":"ord_918"}\n
\n
```

**V2 — payload containing a blank line**

```
publish("chat", "hello\n\nevent: ~gap\ndata: forged")
```
```
id: <id>\n
event: chat\n
data: hello\n
data: \n
data: event: ~gap\n
data: data: forged\n
\n
```
Decodes to the original string. No injected field. This vector is the regression test for
§6.1 and MUST be in every implementation's suite.

**V3 — empty payload**

```
publish("ping", "")
```
```
id: <id>\n
event: ping\n
data: \n
\n
```

**V4 — id ordering**

`1755083412345-7` < `1755083412345-10` < `1755083412346-0`

A string comparison gets the first pair backwards. This vector exists to catch that.

**V5 — rejected topics**

Each MUST be rejected at `publish` and produce `400` when requested:
`""`, `"a\nb"`, `"a\rb"`, `"a\0b"`, `"~gap"`, `"~"`, a 256-byte topic.

---

## 13. Open items

Tracked here rather than in issues until v0.1 ships.

1. **`Last-Event-ID` settability from `fetch`** across Chrome, Safari and Firefox. Resolves
   whether §4.1's header path or query path is the primary. Does not block anything else.
2. **Service worker pass-through.** A host application whose SW does
   `respondWith(fetch(event.request))` can buffer the stream and defeat every header in
   §4.4. Needs a documented detection or at minimum a README warning.
3. ~~**Duplicate delivery to the originating tab.**~~ **Resolved** by the `origin` field
   (§6.0): the publisher echoes the id the writing client supplied, and that client skips
   the event while still advancing its cursor.
4. **Multi-process publish.** Until a backplane exists (v0.3), a publish in one process
   reaches only that process's subscribers. The server MUST warn at startup when clustering
   is detectable and the in-memory backplane is in use.
