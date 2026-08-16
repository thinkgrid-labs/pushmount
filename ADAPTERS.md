# Writing an adapter

How to bring aghoz to another language. Read [PROTOCOL.md](./PROTOCOL.md) first — this
document assumes it and does not repeat it.

The short version: **you are not implementing the protocol.** The protocol lives in one
Rust crate behind a C ABI, and you bind to it. What you write is the HTTP layer — sockets,
headers, ordering, teardown — which is not portable and should not be forced through FFI.

```
  core/        Rust      ids, validation, encoding, history, checkpoint, backpressure
  abi/         C ABI     22 functions, the surface you bind to
  your code    yours     HTTP
```

---

## Before you start

**Can your runtime hold a connection for the lifetime of a page?** If not, stop here —
nothing else in this document will help.

| runtime | holds a connection | notes |
|---|---|---|
| Node, Go, Rust | yes | |
| FastAPI / Starlette on Uvicorn | yes | multi-worker by default → backplane required |
| Laravel Octane (Swoole, RoadRunner) | yes | multi-worker → backplane required |
| PHP under FrankenPHP worker mode | yes | multi-worker → backplane required |
| Flask on WSGI + Gunicorn | technically | a stream occupies a sync worker for its whole life; ten readers is ten workers gone. Document it as unsupported rather than let someone discover it |
| PHP-FPM, `mod_php` | **no** | request-per-process. Out, permanently |
| Vercel, Lambda, Cloudflare Workers | **no** | out, permanently |

**Does your runtime deploy multi-worker by default?** Gunicorn, Puma and Swoole do. Then a
backplane is a prerequisite, not a later feature: without one, a publish in one worker
reaches a fraction of your subscribers and *nothing errors*. Use `ag_append` and
`ag_encode` (below) — they exist for exactly this.

**Can you inject a clock?** The HTTP conformance suite pins `now()` so that ids are
deterministic and frames compare byte-for-byte. If your API cannot accept an injected
clock, add one before you go further.

---

## The ABI

`abi/include/aghoz.h` is the contract, and it is commented for you rather than generated.
Read it. Three rules hold everywhere:

- **Nothing is NUL-terminated.** Every string is a pointer and a length. Payloads may
  legitimately contain NUL — §3 forbids control characters in *topics*, not in data — and
  a `strlen` here silently truncates user content.
- **Rust allocations are freed by Rust.** Everything handed out has a matching `*_free`.
  Never call your own `free()` on it.
- **No panic crosses the boundary.** An internal failure arrives as `AG_ERR_PANIC`, never
  as an unwind into your runtime.

Check `ag_abi_version()` at load and refuse a library whose **major** differs
(`major * 1000 + minor`; currently 3100). A minor difference is additive and safe.

### The calls you cannot do without

| call | why |
|---|---|
| `ag_publish` | assigns an id, encodes, matches subscribers |
| `ag_subscribe` | registers, decides the checkpoint, snapshots replay — **one call, deliberately** |
| `ag_note_buffer` *or* `ag_note_sent`/`ag_note_flushed` | §8.2 |
| `ag_remove` | teardown |
| `ag_cursor` | §5 |
| `ag_gap_frame`, `ag_denied_frame` | §7 |

`ag_subscribe` is one call because §4.5 requires registration, the checkpoint decision and
the replay snapshot to describe **one instant**. Split across two FFI calls, a publish can
land between them and a real gap goes unreported. The pieces are not offered separately;
do not build your own.

### Backpressure: pick the right one

`ag_note_buffer` takes the socket's **absolute** outstanding depth. Use it if your runtime
can tell you that number — Node's `res.writableLength` is exactly it, and then the socket
is the authority and no accounting can drift away from it.

Most runtimes cannot. ASGI's `await send()` suspends until the transport accepts the data
and returns nothing; Go's `http.ResponseWriter` and Swoole are the same. Use
`ag_note_sent` / `ag_note_flushed` instead: report bytes as you hand them over, report them
again as they drain. Both styles feed one counter and one threshold, so the drop decision
is identical — but **do not mix them on one subscriber**. See DECISIONS.md D10.

### Ids are text across the boundary

`ag_append` and `ag_encode` take the id as canonical `<ms>-<seq>` **text**, not split
halves, so §2.1's parsing rule stays in the core. Do not parse an id in your language.
Every language has its own wrong answer — one accepts leading zeros because it calls
`parseInt`, another accepts `1e5` because it calls `Number`, a third accepts `" 1-0"`
because its integer parser skips whitespace. Both halves are bounded at 2^53 − 1 (D9).

Formatting an id is safe and you will need it: `ag_cursor` hands back halves, and
`<ms>-<seq>` with no padding is unambiguous.

---

## The HTTP layer, in order

This is the part you write, and **the order is the product.** Every step below prevents a
specific failure, and most of them fail only in production. Each links the scenario that
catches it.

### 1. Parse — §4.1

- **Split `topics` on comma *before* percent-decoding each element.** Decoding first loses
  the boundary between a separator and a `%2C` inside a topic, and the client silently
  subscribes to topics it did not ask for. → `H6`
- Reject a missing or empty `topics`. → `H1`, `H2`
- Reject malformed percent-encoding rather than passing it through raw. → `H3`
- Validate every topic through the core. → `H4`, `H5`
- Read the cursor from the `Last-Event-ID` **header** first, then the `last_event_id`
  query parameter. The header wins. → `H23`
- **A malformed cursor is a 400, never a silent downgrade to "no cursor".** A client that
  believes it resumed and did not has lost data with nothing reporting it. → `H7`, `H8`, `H9`
- Ignore unknown query parameters — §11. → `H10`

### 2. Authorize — §4.3

Run **after** the host's own middleware, so the request already carries whatever principal
it established. That is the entire premise; a route that authorizes before the host's auth
has run is the one route in the application that bypasses it.

- Call the host's `authorize` once per requested topic; split into allowed and denied.
- Every topic denied → **403**. → `H11`
- Some denied → **200**, and name the refused ones in a `~denied` frame. → `H12`, `H15`
- `authorize` raises → **500**. Unknown must never resolve to allowed. → `H14`
- Capacity → **429** with `retry-after`. → `H16`, `H17`

### 3. The atomic block — §4.5

**No `await` may appear between the start of this block and the end of it**, except the
one noted below. Registration, the checkpoint decision and the replay snapshot must
describe one instant.

The ordering rules here are, in sequence, and each one was a real bug:

1. **Register the subscriber first** — `ag_subscribe`. From this moment a live frame can
   arrive for a connection whose response has no headers yet, so queue anything that
   arrives into a pending buffer. → `H31`
2. **Register teardown immediately after registering**, not after the await below. A
   client aborting mid-replay otherwise leaks a subscriber that nothing ever removes, and
   its pending buffer grows with every publish for the life of the process. → `H33`
3. **If you fetch shared history from a backplane, that await goes here** — and only here.
   It is safe only because registration already happened, so nothing published during the
   round trip is lost. It may be delivered twice instead, and the client dedupes by id.
4. **Re-check that the connection still exists after the await.** It may have been dropped
   across it — by a client abort, by an eviction, by hub shutdown. Writing headers now
   means writing to a response someone has already finished with. Answer 503 instead.
5. **Write the headers** — §4.4:
   - `content-type: text/event-stream; charset=utf-8`
   - `cache-control: no-cache, no-transform`
   - `x-accel-buffering: no` — without it a proxy buffers the stream and nothing arrives
     until the connection ends. → `H18`, `H32`
   - `last-event-id-checkpoint`, **only if a cursor was presented**. Omit it entirely
     otherwise; do not send it empty. → `H19`, `H20`, `H21`, `H22`
6. **Disable socket timeouts and enable no-delay**, or the stream works locally and dies
   behind a proxy.
7. **Write in this order: `:ok`, then `~denied`, then `~gap`, then replay, then anything
   that queued during step 3.** → `H24`, `H25`, `H26`

Do not write a frame before the headers. In Node that flushes implicit headers and loses
every one of them, checkpoint included; expect an equivalent hazard in your runtime.

### 4. Liveness — §6.2

Send `:ka` on an interval below typical proxy idle timeouts (20s is the default here). Use
**one shared timer**, not one per subscriber — a timer per open tab costs a great deal for
no benefit. Skip connections still inside the atomic block; a keepalive is a ping with
nothing to say, and writing it before the headers destroys them. → `H32`, `H37`, `H38`

### 5. Teardown — §8.2

- Remove the subscriber on **both** the request's and the response's close events. Both
  fire in the ordinary case, so removal must be idempotent; listening to only one leaks a
  subscriber per tab that ever connected. → `H39`
- When you drop a connection deliberately, **remove it from your map before ending the
  response**. Otherwise the close event your own drop causes overwrites the real reason,
  and a total filed under the wrong cause sends whoever reads it after the wrong problem.
  → `H40`

### 6. Counters — §10

Keep these in your layer, not in the core. A counter is not a protocol rule, and pushing
one through FFI buys an ABI break for a number no wire format depends on (D5).

Report totals, never rates — ship `uptimeMs` alongside and let the caller derive them.
Attribute closes and rejections **by cause**. → `H40`, `H41`

**Do not mount a metrics endpoint.** The library's premise is that the host's auth runs
first; a route you mounted would be the one thing bypassing it, and connection counts are
a description of the host's traffic. Hand back a snapshot and let them mount it.

---

## Proving it

Two corpora, both language-neutral, both mandatory.

**1. The vector corpus** — [`conformance/`](./conformance/), 94 vectors in nine groups.
Read `vectors.json` directly from your language. Every group is a pure function of the
core, so if you bound to the ABI correctly you get these for free; if you reimplemented
something, this is where it shows.

**2. The HTTP suite** — [`conformance/http/`](./conformance/http/), 41 scenarios over a
real socket. Ship the small test app described in that README and run the harness against
it. This is the one that judges *your* code.

```sh
node conformance/http/runner.mjs "your-command-to-boot-the-test-app"
```

Report the corpus versions you pass. `vectors.json` and `scenarios.json` each carry a
`version`, bumped whenever an expectation changes.

### Expect the checklist above to be wrong somewhere

It was derived from one implementation. The second one will find something it does not
say, and the right response is a pull request against this file **and** a scenario that
pins the rule — not a note in your own README. A rule that lives only in prose is a rule
two implementations will get wrong differently; this project has three decision records
proving it (D6, D9, D10).

---

## What not to build

**A sidecar.** It is tempting for a runtime that is awkward to bind: run the hub as a local
process and talk to it over a Unix socket, no FFI required. It would work, and it would
undo the premise. The argument against Mercure and Centrifugo is that a hub outside your
application has never seen your user table, so authorization has to be rebuilt as a token
subsystem — and a sidecar on `localhost` has exactly the same blindness. A shorter network
hop is not a different architecture. The moment `authorize(req, topic)` is answered across
a socket instead of as a function call, you have rebuilt the thing this library exists to
delete.

The standalone hub on the v1.0 roadmap is a different proposition: an escape hatch for
teams who have outgrown one process and are accepting the token cost knowingly, in
exchange for scaling the hub independently. Not a porting convenience.
