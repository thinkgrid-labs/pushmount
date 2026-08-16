# Decision record

Decisions that are expensive to reverse, with the evidence that produced them.
Newest first.

---

## D8 — Svelte gets stores, Vue gets a shallow ref

**Date:** 16 August 2026 · **Status:** accepted

`@aghoz/vue` and `@aghoz/svelte` complete v0.2. Both are thin wrappers over
`@aghoz/client` and restate no protocol decision.

### Svelte: stores, not runes

Runes are the current idiom, and stores are the right answer anyway.

`svelte/store` readables are plain JavaScript. One package covers Svelte 4 and Svelte 5,
this repo's build gains no compiler step, and no rune syntax pins the package to a major
version. Svelte 5 still auto-subscribes with `$topic`, so nothing about the rendering code
differs. A runes implementation would have meant a `.svelte.js` module, the Svelte compiler
in the build, and a package that could not serve Svelte 4 at all — in exchange for
identical call sites.

The lifetime comes free, which is the part that actually matters. A readable's start
function runs on the first subscriber and its teardown after the last, so `$topic`
auto-subscription *is* the subscription lifecycle: nothing to clean up, and no leak when a
component is destroyed.

**Consequence, made explicit rather than papered over:** a `topicReducer` restarts from
`initial` when its subscriber count returns to zero and rises again, and it now publishes
that reset rather than only holding it internally. A readable retains its last value across
a stop, so the first version reported the *previous* run's final state until the next event
arrived and then jumped to a fold that had silently dropped it. Restarting is correct — a
fold is only meaningful over an unbroken run of events, and carrying state across a gap in
subscription would be a fold over events it never saw — but the accumulator and what
subscribers see have to start from the same place. Caught by the test that asserted it.

### Vue: `shallowRef`, and a reactive topic

The ref holding a payload is shallow. A deep `ref` would wrap every payload in a reactive
proxy, so an object published is not `===` the object received and any identity check
downstream silently stops working. Payloads arrive whole and are replaced whole; deep
reactivity has nothing to do here but cost. There is a test that pins the identity.

Topics accept `MaybeRefOrGetter`, unlike the React binding's plain string, because that is
the Vue idiom and the subscription is driven by a `watch` whose cleanup both resubscribes on
change and unsubscribes on scope disposal — one mechanism for both, rather than a call plus
a separate `onScopeDispose`.

### Both take an explicit `client`

Every function in both packages accepts one, overriding injection or Svelte context.

Not only for tests, though it is what makes these packages testable in bare Node with no
jsdom and no compiler. Vue's `inject` needs a component or app context and Svelte's
`getContext` throws outside component initialisation, so without the override neither
binding could be used from a plain module — a store defined at module scope, a composable
called from a router guard. Svelte's failure is also opaque (`lifecycle_outside_component`),
so `getAghozClient` catches it and reports the two fixes by name.

---

## D7 — The Nest adapter provides a hub, not a route

**Date:** 16 August 2026 · **Status:** accepted

`@aghoz/nest` ships `AghozModule.forRoot`/`forRootAsync`, an `AGHOZ_HUB` token and
`createAghozHandler`. It does **not** register a controller, and it works on both the
Express and Fastify platforms.

### Why no controller

Auto-mounting is what a Nest integration is normally expected to do, and it is wrong here.
A route this package registered would carry none of the application's `@UseGuards()`, and
guards are where a Nest application's authentication lives. The premise of the whole
library is that the host's authentication runs *before* the hub sees a request — so the
convenience feature would quietly produce the one route in the app that bypassed it.

This is the same line D5 drew in refusing a metrics endpoint, and it is worth being
consistent about: this library does not mount routes, because it cannot know what is
supposed to guard them.

The cost is a ten-line controller in the README. The alternative was a class generated
inside `forRoot` — which also cannot accept the user's guards, since decorators are applied
at class-definition time, before `forRoot` is ever called.

### Why `@Sse()` is unusable

Predicted on the roadmap and confirmed. `@Sse()` takes an Observable and writes the
response itself: it owns the status, the headers and the framing, and exposes no way to add
one. `last-event-id-checkpoint` (§4.4) is therefore unreachable, so a client can never be
told it missed events — which is the only thing this library does that polling does not.
The adapter uses `@Res()`, putting Nest in library-specific mode.

Exactly the reason `@aghoz/client` does not use `EventSource`: an abstraction that owns the
response owns what can be said in it.

### `beforeApplicationShutdown`, not `onApplicationShutdown`

Found by the test suite hanging after every assertion passed. Nest tears down in this
order: `onModuleDestroy` → `beforeApplicationShutdown` → **close the HTTP server** →
`onApplicationShutdown`.

`server.close()` waits for open connections to end, and an SSE stream never ends on its own
— that is what it is for. A hub still holding subscribers when the server closes means
`app.close()` never resolves, and closing at `onApplicationShutdown` is too late to help
because nothing reaches it. Dropping subscribers one step earlier lets the server find
itself idle.

Worth recording because the wrong hook is the obvious choice, the symptom appears nowhere
near the cause, and it is invisible to anyone who never opens a stream before shutting down.

---

## D6 — Truncation is decided against the newest evicted id, not the oldest retained one

**Date:** 16 August 2026 · **Status:** accepted · **Amends:** PROTOCOL.md §4.4, §8.1

Both cores computed `truncated = cursor < oldest_retained_event`. That is wrong in both
directions, and the metrics work in D5 is what surfaced it — `truncated` was the number
the README had just finished calling the one worth alerting on.

### The false positive

`0-0` is the cursor §5 hands out before anything has been published, and the quickstart
tells you to pass it to the page alongside its initial data. It sorts below every real id,
so on a freshly booted hub the first stream connect compared as `earliest` — replaying
everything correctly *and* reporting a gap the client could not possibly have had:

```
cold cursor      : 0-0
history length   : 2 (nothing was ever trimmed)
frames replayed  : 2
truncated        : true
```

Every first page load after a deploy refetched, and a signal that fires when nothing is
wrong is a signal people learn to ignore.

### The false negative, which is worse

An event larger than the entire history budget is evicted by the push that stored it,
leaving the ring **empty**. With no oldest retained entry there was nothing to compare
against, so the guard `oldest !== undefined` short-circuited and a real loss was reported
as "nothing missed". That is silent staleness — the single failure mode §0 says this
protocol exists to eliminate — reachable from one oversized publish.

### Decision

Track the **highest id ever evicted** and compare against that:

```
truncated = last_trimmed !== null && cursor < last_trimmed
```

A cursor *equal to* the evicted id is not a gap: that is the event the client already
holds, and everything after it is still retained. Never having evicted anything means no
cursor can have missed anything, including `0-0`.

Held as a maximum rather than "the last one popped", so an out-of-order `append` — a
backplane replaying into the ring — can only push the mark forward. Over-reporting is a
false alarm; under-reporting is data loss with no symptom, and the two are not equally bad.

### Why this got a corpus category rather than two matching patches

`checkpoint` is the sixth group in `conformance/vectors.json` (7 vectors, 50 → 57). The
bug existed identically in TypeScript and Rust, which is exactly the failure the corpus is
supposed to make impossible — and it had gone unnoticed because the corpus covered
encoding, validation and id order, but never the decision those exist to serve.

Fixing it in two places without a vector would have left the next implementation free to
reintroduce it. All three runners now execute the same seven vectors: the TypeScript core,
the Rust core directly, and the Rust core through its Node binding. Confirmed to fail on
the unfixed code first — CP1, CP4 and CP7, identically in both languages.

No ABI change: the binding already reported the checkpoint as `"absent"`/`"echo"`/
`"earliest"`, so the corpus asks it the same question it already answered.

---

## D5 — Counters live in the handler layer, and are counters rather than rates

**Date:** 16 August 2026 · **Status:** accepted

`hub.stats()` is implemented entirely in `packages/server/src/stats.ts` and wired from
`create-hub.ts`. Nothing was added to `hub.ts`, to `HubCore`, or to the C ABI.

### Why not the core

D3 put one Rust core behind a stable C ABI precisely so protocol rules could not diverge
between languages, and `conformance/vectors.json` is what enforces it. A counter is not a
protocol rule. Putting one in the core would have meant a third ABI break, a new corpus
category and a matching implementation in every future binding — for a number no wire
format depends on and no other implementation has to agree about. `hub.ts` already says
"do not add behaviour here that the corpus does not pin down", and this is the first real
test of that line.

The placement also happens to be where the interesting failures are. Every close reason
worth distinguishing — a client abort, a §8.2 drop, a §4.6 revocation, an eviction, a
shutdown — is a socket-layer event the core never sees.

**The cost, accepted:** ring occupancy — how full `maxHistoryBytes` is — is core state the
ABI does not expose, so it is not reported. `truncated` covers the consequence, which is
the part anyone would alert on; the cause can be added when the ABI grows a reason to
change anyway. Buying it now would mean breaking the ABI for a gauge.

### Why totals and not rates

The roadmap item said "publish rate". What shipped is `published` plus `uptimeMs`.

Any window this library averaged over would be the wrong one for someone, and it is not
reversible from the outside: a consumer handed a smoothed rate cannot recover the counter,
while a consumer handed a counter can compute any rate it likes. Prometheus, StatsD and
OpenTelemetry all expect counters and derive rates themselves, so emitting a rate would
mean every one of them undoing work this library did not need to do.

### Why closes are attributed rather than totalled

`closed` is a map by cause, not a number, and `rejected` likewise. A total that is right
but filed under the wrong reason is worse than no metric at all — it sends whoever reads
it after the wrong problem with full confidence.

Making that trustworthy shaped the code: `drop()` takes its reason from the caller and is
idempotent, deleting from the connection map *before* `res.end()`. Without that ordering
the `close` event a deliberate drop causes would land a second later and record `client`,
and every eviction, revocation and slow-consumer drop would be invisible under a
plausible-looking client-churn number. `packages/server/test/stats.test.mjs` pins it.

Rejections are bucketed by a `status → reason` mapping in one place rather than at each
call site, for the same reason: the two travelling separately is how a bucket ends up
mislabelled. Its default arm is `bad-request`, so a status added later is counted as
something rather than vanishing from the totals.

### Not shipped: a metrics endpoint

`cursorHandler()` exists, so a `metricsHandler()` would have been the consistent move. It
was rejected. The premise of this library is that the host application's authentication
runs before the hub sees a request; a route the library mounts itself would be the one
thing in it that bypassed that, and connection counts and rejection reasons are a
description of the host's traffic. The README shows the three-line mount instead.

---

## D4 — Name: aghoz, final

**Date:** 15 August 2026 · **Status:** accepted · **Supersedes:** D0

D0 deferred the name and made `pushmount` the working default, on the grounds that the
open question — *does "push" read as the Web Push API?* — would be answered by evidence
rather than by argument. It named two triggers to revisit: a real user reporting the
confusion, or the moment before claiming the npm organisation, which is the first
irreversible step.

The second trigger arrived, together with a clearer statement of what the name is for: a
brand, not a description.

### Decision

**`aghoz`** — from the Filipino *agos*, "flow" or "current".

Clear on npm, crates.io and GitHub. Notably it is the *only* spelling in that family that
is: `agos` itself is taken on both npm and the GitHub organisation, and `agoz`, `aghos`
and `agosa` all have the organisation taken. The available name and the wanted name
happened to coincide, which is not the usual outcome of a naming round.

### What was rejected, and why it is worth writing down

**`heartbeat`** — taken on npm, crates.io and GitHub, and colliding with two established
infrastructure tools (Elastic's Heartbeat, the Linux-HA daemon). The disqualifying problem
is closer to home though: "heartbeat" is the industry term for the SSE keepalive comment
that holds a connection open, which this project *sends* — §6.2, `:ka` frames, the
`keepAliveMs` option. A product cannot be named after one of its own internal mechanisms
without losing the ability to talk about either.

**`pushmount`** — the incumbent, and a genuinely good description: "mount" names the
differentiator against Mercure and Centrifugo in one word. But a description is not a
brand, and "push" in a JavaScript package continues to read as the Web Push API. Its own
D0 flaw was never resolved, only deferred.

### The cost, and why it was paid now rather than later

§0 keeps the name off the wire and a conformance test enforces it, so the rename was a
find-and-replace across manifests, imports and prose — no compatibility consequence, and
the invariant now asserts that "aghoz" is absent from every wire literal, which is the
proof the rename stayed a rename.

The one part that was *not* free is the C ABI, where every symbol carried a `pm_` prefix.
Renaming those to `ag_` is an ABI break. It cost nothing today only because `pm_publish`
had just gained its §6.0 `origin` parameter and `PM_ABI_VERSION` had already been bumped
1000 → 2000 in the same session — so one break absorbed both changes. A month from now,
with a Python or Go binding built against it, that would have been a second break and a
second version. Deciding the name before the first binding ships was worth more than
deciding it well.

### The organisation is claimed

`@aghoz` was created on npm on 15 August 2026, which closes the question D0 and D0-history
both left open — the unscoped name had been confirmed free, but npmjs.com returns 403 on
unauthenticated organisation lookups, so the *scope* could never be verified from outside.
It was the last blocker on publishing anything at all, whatever the name turned out to be.

### Known weakness, accepted

`aghoz` cannot be spelled from hearing it: "gh" in English is /g/ in *ghost*, /f/ in
*rough*, and silent in *through*. A developer who hears the name in a talk cannot reliably
find it. This is survivable for a library discovered by search and by reading rather than
by ear, on the condition that the README states the pronunciation and the origin in its
first screen. That is a documentation obligation, not an afterthought.

---

## D3 — One Rust core, in-process bindings per language

**Date:** 13 August 2026 · **Status:** accepted · **Supersedes:** D2

### Why D2 is reversed

D2 was decided correctly against the wrong premise. It asked "does the *Node* hub need
Rust?" and answered no, on measurements that still stand. The actual goal is broader:
**the same in-process hub in Python, Go and Ruby, not only Node.**

That changes what the cost buys. D2 priced a ~2x slowdown on Node's hot path against
avoiding *one* extra implementation, and correctly called that a bad trade. Against
avoiding *five* hand-written hubs — each with its own version of the id rules, the
injection defence and the checkpoint atomicity — it is a good one. 37k publishes/sec
with 37x headroom is affordable in any of them.

The conformance corpus also scales worse than assumed. It works well across two
implementations. Across five it becomes the only thing standing between the project and
five subtly different definitions of "newer than the cursor" — and vector T15 is the
proof that this class of bug recurs independently per language, because every language
has its own wrong answer for "length".

### Decision

1. **`core/` is a Rust crate** owning everything the corpus pins: ids, topic validation,
   frame encoding, the history ring, the subscriber registry, checkpoint-and-replay, and
   backpressure decisions. No IO.
2. **A stable C ABI** is the single surface every language binds to, with idiomatic
   wrappers above it (napi for Node, PyO3, cgo, magnus). This is the SQLite/libgit2
   shape and it exists because the ABI is the expensive thing to change, not the core.
3. **HTTP stays per-language.** Sockets, headers and framework integration are not
   portable and should not be forced through FFI. Only the protocol is shared.
4. **The existing 93 Node tests are the acceptance suite for the core.** Swapping the
   TypeScript hub internals for the Rust core must leave every one of them passing,
   unchanged. That is a far stronger completeness check than new Rust tests written in
   isolation would be.

### The consequence that reorders the roadmap

**The backplane stops being a v0.3 feature and becomes a prerequisite for the second
binding.**

Node applications are commonly single-process. Gunicorn and Puma are multi-*worker* by
default — that is the recommended configuration, not an edge case. An in-process hub in
a Django app under four workers delivers each publish to a quarter of its subscribers,
silently. The startup warning added in P5 would fire on a normal deployment rather than
an unusual one, which makes it noise instead of a signal.

So: Redis backplane before Python or Ruby ships, not after.

**PHP is out.** PHP-FPM's request-per-process model cannot hold a long-lived connection
at all. Say so in the README rather than leaving people to discover it.

---

## D2 — The Node hub is TypeScript. Rust is for the standalone hub.

**Date:** 13 August 2026 · **Status:** **superseded by D3** — the measurements below
remain valid; the premise they were applied to did not · **Evidence:**
`spikes/wasm-vs-ts/`

### What was claimed

The build plan argued that a Rust core compiled to wasm should back
`@pushmount/server`, on two grounds: that a hand-written TypeScript hub would drift from
the Rust one, and that wasm avoids the prebuild matrix and `.node` bundler problems that
a native addon brings.

Both grounds were assertions. P0 exists to measure them.

### What was measured

A minimal hub — id assignment with the §2.2 monotonicity rule, §3 topic validation,
§6.1 frame encoding with payload segmentation, a byte-bounded history ring, and
subscriber matching — was written twice: once in Rust compiled to wasm, once in plain
JavaScript. An equivalence gate asserts byte-identical frames on every conformance vector
before any timing runs.

Apple Silicon, Node 22.22.2, `wasm-pack --release` with `lto = true`:

| scenario | wasm ops/s | JS ops/s | ratio |
|---|---|---|---|
| 200 B payload, 0 subscribers | 348k | 253k | **1.38x** |
| 200 B payload, 100 subscribers | 233k | 201k | **1.16x** |
| 200 B payload, 1000 subscribers | 37k | 45k | **0.83x** |
| 2 KB payload, 100 subscribers | 48k | 74k | **0.65x** |

Isolating the boundary from the logic, at 200 B and 100 subscribers:

```
rust logic only, no boundary crossing    434k ops/s
wasm as called from node                 233k ops/s   ← 46% lost to marshalling
plain javascript                         201k ops/s
```

### What that means

**The Rust logic is genuinely 2.2x the JavaScript.** That part of the claim held. But
marshalling costs 46% of it, and the cost scales with payload size — strings are copied
into linear memory on the way in and the frame is copied out on the way back, once per
publish. At the payload sizes real applications send, **wasm is slower than plain
JavaScript**, by up to 35%.

Zero-copy reads of the frame out of linear memory would recover part of this. They would
not change the decision: the ceiling is 434k and JS already delivers 201k, against a busy
single-process application publishing on the order of 1k/sec. Both implementations have
two orders of magnitude of headroom. **The Node path has no performance argument for
Rust, in either direction.**

**The divergence argument was also weaker than claimed.** The spike's TypeScript hub is
byte-identical to the Rust one on every vector, and the equivalence gate proves it on
every run — it failed loudly during development when the two disagreed. A second
implementation is not inherently unsafe when a conformance corpus is the arbiter. That
was the main argument for wasm and the measurement did not support it.

### Decision

1. **`@pushmount/server` v0.1 is pure TypeScript.** No wasm, no napi, no prebuild
   matrix, no `.node` files, no `optionalDependencies`, zero runtime dependencies. This
   is the strongest possible position for the ten-minute definition of done, which is the
   metric the product is actually judged on.
2. **The Rust core is built in v0.3, for the standalone hub**, where there is no
   JavaScript, no boundary, and the 2.2x is uncontested — and where the backplane owns id
   assignment, which is the part that genuinely benefits from one careful implementation.
3. **`PROTOCOL.md` §12 is the contract between them.** The corpus is generated once and
   both implementations are tested against it in CI. `spikes/wasm-vs-ts/bench.mjs` is the
   prototype of that gate.

### The cost of this decision, stated plainly

From v0.3 there are two hub implementations to keep in step, forever. The spike covered
roughly the easy fifth of the surface — it does not include replay ordering, backpressure
accounting, gap conditions, connection caps, or backplane sequencing. The corpus mitigates
drift but does not eliminate the work.

**Evidence from both directions, added after the corpus was built.** Vector T15 found a
real divergence on its first run: §3 bounds a topic at 255 **bytes**, but the JavaScript
hub measured `topic.length`, which counts UTF-16 code units. An 86-character Japanese
topic is 258 UTF-8 bytes — rejected by Rust, accepted by JavaScript, and a validation
bypass on the field whose validation exists to prevent frame forgery.

Read pessimistically, that is the two-implementation risk made concrete, and it appeared
in the *easy* fifth of the surface. Read optimistically, the corpus caught it in under a
second, on the first run, before any of it shipped — which is precisely the guarantee this
decision rests on. Both readings are fair. What the episode does settle is that the
guarantee is only as good as the corpus, so under D2 the corpus is not a deliverable that
can be deferred.

The alternative — accepting a measured ~2x slowdown against plain JavaScript, plus a wasm
artifact in the npm package, to avoid that maintenance — is a legitimate choice. It is
just not the one the numbers favour.

### Alternative not measured

napi-rs marshals more cheaply than `wasm-bindgen` and would land somewhere between the
two columns. It was not benchmarked because it reintroduces exactly what the definition of
done can least afford: a six-platform prebuild matrix, a Rust toolchain fallback, and the
`.node` webpack-alias failure that has bitten this author before. If D2 is reversed in
favour of a native binding, benchmark napi first.

---

## D1 — `Last-Event-ID` is settable from `fetch`; the header path is primary.

**Date:** 13 August 2026 · **Status:** accepted for Chromium, open elsewhere ·
**Evidence:** `spikes/last-event-id/`

`PROTOCOL.md` §4.1 accepts a cursor from either the `Last-Event-ID` request header or a
`last_event_id` query parameter. The query parameter exists only in case the header is a
forbidden header name under the Fetch spec, in which case the browser drops it *silently* —
shipping a client that appears to reconnect with a cursor while actually reconnecting
without one, which is precisely the invisible loss the product claims to eliminate.

An echo server plus a browser page settles it by observation rather than by reading the
spec.

| engine | result |
|---|---|
| Chromium 151 (HeadlessChrome) | **PASS** — header arrives, canonical and lowercase; query fallback also works |
| Firefox | not run — not installed on this machine |
| Safari | not run — `safaridriver --enable` requires user authorisation |

`Last-Event-ID` does not appear in the Fetch spec's forbidden-request-header list, which
is consistent with the Chromium result and makes divergence unlikely. **Unlikely is not
verified.** Run `node spikes/last-event-id/server.mjs` and open `http://localhost:8787`
in Safari and Firefox before the client ships; the page states its own verdict.

**Decision:** header is the primary path. The query parameter stays in the protocol as a
fallback and is exercised by tests regardless, because it costs nothing and it is the
escape hatch if a future engine disagrees.

---

## D0 — Name: pushmount, held provisionally

**Date:** 13 August 2026 · **Status:** **superseded by D4** — the deferral did its job;
the name was settled on evidence rather than on the speculation this entry declined to
make. Kept unedited, because a decision log that rewrites what it once concluded is worth
nothing.

Five rounds of candidates did not converge, because they genuinely are close: each one
trades a real flaw for a different real flaw. Continuing to deliberate was costing more
than the gap between the finalists.

| candidate | availability | the flaw |
|---|---|---|
| **pushmount** *(incumbent)* | npm, crates, org, `.dev`, `.com` | "push" in a JS package reads as the Web Push API |
| pubward | all clear, zero prior art anywhere | `-ward` means *toward*, inverting the one-way direction; "pub" reads as a bar |
| tailfeed | all clear | "feed" leans RSS |
| subflare | all clear except `.com` | "-flare" reads Cloudflare-adjacent in exactly this space |
| eventfold | crates.io taken | "event" collides with event sourcing and `EventSource` |
| praeco | org and `.dev` taken | an existing 577-star Elasticsearch alerting tool |
| spargos | org taken | not a Latin form; the correct `spargo` is taken on npm |

### Why deferring is the right call rather than a dodge

The open question — *does "push" make people think this is the Web Push API?* — has a
real answer, and we do not have it. It arrives as the first confused issue, or as the
absence of one. Deciding now means deciding on speculation; deciding later means
deciding on evidence.

Deferring is only available because §0 keeps the name off the wire. It appears in package
manifests, imports and prose, and nowhere else. Renaming stays a find-and-replace with no
compatibility consequence, **including after v0.1 ships**. A conformance test enforces
that property, so it cannot quietly decay.

When candidates are this close, the incumbent wins by costing nothing: `pushmount` is
already in the repository with the suite green.

### Revisit when

- a real user reports confusion with Web Push, or with Pusher/Pushpin/Pushover; or
- we are about to claim the npm organisation, which is the first irreversible step.

**Still unverified:** the `@pushmount` npm *scope*. npmjs.com returns 403 on
unauthenticated org lookups, so only the unscoped name was confirmed free. This is the
one blocker on publishing, whatever name wins.

---

## D0-history — the naming rule that made deferral possible

**Date:** 13 August 2026 · **Status:** accepted

Chosen from a checked shortlist. Clear on npm (unscoped), crates.io, GitHub org,
`pushmount.dev` and `pushmount.com`. Rejected: `downwire` (working name), `hudyat` /
`sigaw` (Filipino; user asked for English), `tailfeed` (clear, `tail -f` metaphor),
`newswire` and `tailwire` (org or domain taken).

"Mount" names the differentiator — the hub is a route inside the host application, not a
service you deploy — which is the positioning against Pusher, Mercure and Centrifugo in
one word.

**Open:** the `@pushmount` npm **scope** is unverified. npmjs.com returns 403 on
unauthenticated org lookups, so only the unscoped name was confirmed free. Confirm by
creating the org before P5.

**Standing rule:** the product name never appears on the wire (`PROTOCOL.md` §0). This is
why the SSR cursor stamp is `event-cursor` and not `pushmount-cursor`. A conformance test
enforces it.
