# HTTP conformance suite

The second half of the corpus. [`../vectors.json`](../vectors.json) pins the protocol
**core** — bytes in, bytes out, no sockets — and every implementation gets that for free by
linking the same Rust. This one pins the layer above it: statuses, headers, write order,
teardown, attribution.

That layer is the one each language rewrites in full, and until this existed nothing
checked it.

```
                     lines    pinned by
  core/               ~915    94 vectors, three runners
  abi/                ~800    Miri, 34 roundtrip tests
  the HTTP layer      ~950    42 scenarios, over a real socket   ← this
```

An adapter can pass 94/94 vectors and still be wrong in every way that matters: omit
`x-accel-buffering` and stream nothing through a proxy, answer `403` where `429` belongs
and send clients into a sign-in loop, compute the checkpoint after an interleaved publish
and under-report a real gap, or leak a subscriber on every abort. None of that is visible
to the vector corpus, and all of it is visible here.

## Running it

```sh
node runner.mjs "node adapters/node/app.mjs"
```

The harness spawns the command, reads a port off its stdout, and speaks HTTP. It never
links anything — which is the whole point, and the reason a Python or Go adapter can be
held to exactly this contract.

```
layout
  scenarios.json        the corpus — 42 scenarios in seven groups
  build-scenarios.mjs   regenerates scenarios.json
  runner.mjs            the harness
  adapters/node/        the Node reference app
```

## Groups

| group | count | covers |
|---|---|---|
| `request` | 10 | §4.1 parsing, topic and cursor rejection |
| `authorize` | 7 | §4.2 / §4.3 statuses, partial denial, caps |
| `headers` | 6 | §4.4 the header set and the checkpoint |
| `order` | 7 | §4.5 write order on connect, framing over the wire |
| `window` | 3 | §4.5 the atomic block, once replay crosses a network |
| `cursor` | 3 | §5 the cursor endpoint |
| `lifecycle` | 5 | §6.2 keepalive, §8.2 teardown, §10 attribution |

## The adapter contract

An adapter ships a small app implementing the surface below. Roughly 130 lines in Node;
budget something similar elsewhere. Keep it the plainest possible use of your own API — a
failing scenario must mean the adapter is wrong, not that the test app was clever.

**Boot.** Listen on any free port and write `listening <port>` to stdout as the first line.

**The protocol endpoints.**

| route | is |
|---|---|
| `GET /events` | the stream handler, mounted the way a user would mount it |
| `GET /events/cursor` | the cursor endpoint |

**The control surface.** Everything under `/_t/`, all JSON.

| route | body | does |
|---|---|---|
| `POST /_t/reset` | hub config | rebuilds the hub, so each scenario starts clean |
| `POST /_t/clock` | `{ms}` | sets the fixed clock |
| `POST /_t/publish` | `{topic, payload, origin?}` | publishes, returns `{id, delivered}` |
| `POST /_t/stats` | — | returns the stats snapshot |
| `POST /_t/disconnect` | `{key}` | evicts connections with that connection key |
| `POST /_t/close` | — | closes the hub |

`reset` accepts `maxHistoryBytes`, `maxBufferBytes`, `maxConnections`,
`maxConnectionsPerKey`, `maxTopicsPerConnection`, `keepAliveMs`, `revalidateMs`,
`backplaneDelayMs` and `clock`. Anything a scenario does not set should take the library's
default, except `keepAliveMs`, which defaults to **off** so a stray `:ka` cannot make an
unrelated frame assertion flaky.

**The clock is fixed, and that is what makes this a corpus rather than a test suite.**
With `now()` pinned at 1000, the first publish is `1000-0` and the next `1000-1`, so
scenarios assert whole frames byte-for-byte instead of matching patterns around a
timestamp. An adapter whose library cannot have its clock injected should say so loudly
rather than approximate this.

**Authorization travels on the request**, via `x-t-authorize`: `all` (default), `none`,
`prefix:<p>`, or `throw`. Per-request rather than per-app because `authorize` sees the
request — that is the library's entire premise — so the rule can ride along on it and one
handler serves every scenario. `x-t-key` is the connection key.

**`backplaneDelayMs`** installs a backplane whose replay sleeps that long, assigning ids
from its own sequencer. It exists to widen §4.5's atomic block far enough to aim at: with
no backplane the block contains no `await`, a connection goes from registered to fully open
in one tick, and the entire `window` group is unreachable. Three separate production bugs
lived in that window.

## Adding scenarios

Same rule as the vector corpus, for the same reason. **Write expectations from
PROTOCOL.md, never capture them from a running server.** A corpus recorded from an
implementation proves only that the implementation is self-consistent — it cannot catch a
bug every implementation would make, and it silently blesses whatever the first one
happened to do.

This project has paid for that lesson three times: [D6](../../DECISIONS.md) (truncation
decided against the wrong thing, identically in both languages), [D9](../../DECISIONS.md)
(an id bound that no JavaScript host could implement), [D10](../../DECISIONS.md) (a
backpressure signal only Node could produce). Each was prose until something executed it.

**Verify a new scenario fails before it passes.** Break the behaviour deliberately, watch
the scenario catch it, then fix it. A scenario that has never failed is a scenario that
might be asserting nothing — which is not hypothetical here: an early version of
`expect-no-id-field` read the consumable frame buffer, so three scenarios passed vacuously
because an earlier step had already drained it. The harness now refuses that assertion
outright when no control frame was received.

The seed set was built this way. These four breaks are each caught by exactly the scenario
that should catch them:

| break | caught by |
|---|---|
| drop `x-accel-buffering` | H18, H32 |
| always send the checkpoint header | H19 |
| decode topics before splitting on comma | H6 |
| write replay before the `~gap` frame | H26 |

## Scenario shape

```json
{
  "id": "H26",
  "desc": "what breaks if this fails",
  "app": { "maxHistoryBytes": 200 },
  "steps": [
    { "op": "publish", "topic": "t", "payload": "v" },
    { "op": "open", "as": "s", "path": "/events?topics=t" },
    { "op": "expect-frames", "of": "s", "frames": [":ok\n\n"] }
  ]
}
```

| op | does |
|---|---|
| `request` | one-shot request; asserts `status`, `headers`, `absentHeaders` |
| `open` / `await-open` | opens a stream and keeps it; `await: false` leaves it pending, which is how the `window` group aims inside the atomic block |
| `expect-frames` | the **next** frames, exactly; `[]` asserts nothing arrived |
| `expect-frame-matching` | waits for a frame containing a substring, consuming up to it |
| `expect-frame-count` | how many frames matched, across everything received |
| `expect-headers` | headers on a stream opened earlier |
| `expect-no-id-field` | §7 — no control frame or comment carries an `id:` |
| `publish` · `disconnect` · `abort` · `sleep` | drive the app |
| `get-cursor` | asserts the cursor endpoint's value |
| `expect-stats` | asserts `connections` and `closed`/`rejected` buckets |

`expect-frames` consumes from the front, so assertions read in stream order. Whole-stream
claims — `expect-frame-count`, `expect-no-id-field` — read everything ever received
instead, because an earlier assertion may already have taken the frame in question.
