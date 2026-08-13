# pushmount

Server push for apps that already have a backend. It mounts into your Express app as a
route, so your authentication runs before it and per-user filtering is one line.

```js
app.get('/events', hub.handler({
  authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
}))
```

No second service. No token exchange. No CORS.

---

> ### ⚠️ Not finished. Under active development.
>
> **Nothing is published.** There are no packages on npm, and the install commands below
> describe the intended shape rather than something you can run today. Build from source
> if you want to try it.
>
> **The API will change without notice**, and so may the wire protocol until it is
> tagged. There is no deprecation policy yet because there is nothing to deprecate.
>
> **Even the name is provisional.** `pushmount` is a working title held deliberately —
> see [DECISIONS.md](./DECISIONS.md) D0. The protocol carries the name nowhere, so a
> rename stays a find-and-replace, and a test enforces that.
>
> What *is* real: the protocol is specified in [PROTOCOL.md](./PROTOCOL.md) and enforced
> by a shared [conformance corpus](./conformance/) that every implementation runs; the
> packages pass 118 tests plus 26 in Rust; and the
> [example app](./examples/express-react) runs end to end, verified in CI. Every
> significant decision — including the two that were reversed — is recorded with its
> evidence in [DECISIONS.md](./DECISIONS.md).
>
> Please don't build a business on it yet. Do open an issue if you try it.

---

## Why this exists

**Most web apps poll.** A client asks the server every few seconds whether anything
changed, and almost every time the answer is no. That wastes battery, wastes requests,
and *still* leaves the interface seconds behind reality. A dashboard on a five-second
interval costs 720 requests an hour, per tab, to mostly learn nothing.

The push alternatives each charge a tax that has little to do with pushing:

**Standalone hubs** — Mercure, Centrifugo — are a second service to deploy, monitor and
keep alive. Worse, that service has never seen your user table. Because it cannot answer
"may this person read this?", you must build a whole authorization subsystem before one
message flows: minting tokens, scoping them to topics, handling expiry, handling
rotation, handling revocation. That subsystem is usually the largest part of the
integration, and it exists only because the hub lives outside your application.

**Sync engines** — ElectricSQL, PowerSync, Zero — are excellent, and they solve a much
larger problem than the one you have. They replace your data layer rather than augmenting
it: a client-side database, a replication protocol, conflict resolution, a migration
story. If you want offline-first local writes, use one of them. If you just wanted the
number on the screen to be current, you have adopted a new architecture to get it.

**Hand-rolled SSE** is fifteen lines that work perfectly on your laptop and fail in
production for reasons nobody on the team remembers a month later:

- compression middleware buffers the stream, so nothing arrives until the connection ends
- a proxy reaps the connection as idle, and it silently stops delivering
- subscribers leak on disconnect, one per tab that ever connected
- and updates go missing across reconnects, with **nothing reporting it**

That last one is the worst, and it is why this project exists. A client showing stale
data forever is worse than one that polls, because nothing fails. No error is logged, no
retry fires, no alert goes off. The page just quietly lies, and the first you hear of it
is a support ticket saying the numbers look wrong.

**So there is no small, correct option** for a team that wants to stop polling without
changing anything else about how their application works. That is the gap this fills:
push that treats missed updates as an error rather than an outcome, mounted inside the
app you already have, small enough to read in one sitting.

---

## Read this before installing

**It will not work on serverless.** Vercel, Lambda and Cloudflare Workers cannot hold a
long-lived connection. There is no workaround and none is planned. If that is your
deployment target, stop here.

**Across multiple processes you need a backplane.** By default a `publish` reaches only
that process's subscribers, and pushmount warns at startup when it can tell it is one
worker of several. Add `@pushmount/redis` and the limitation goes away — see
[Multiple processes](#multiple-processes). Redis is entirely optional; without it there
are no dependencies at all.

**It is not a sync engine.** No offline support, no local writes, no CRDT conflict
resolution, no client-side database. If you need those, see the paragraph above — you
will be happier with a real sync engine than with a bad imitation. Writes here go through
the API you already have; the stream is one-way, permanently.

---

## What makes it different

**Authorization is inherited, not invented.** The hub is a route inside your application,
so by the time it runs, your session middleware has already established who the user is.
The answer to "may this user read this topic?" is a function call against the request you
already parsed:

```js
authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`)
```

That one line replaces the entire token subsystem a standalone hub requires. It is the
single largest source of complexity in every competing product, and mounting in-process
deletes it rather than simplifying it.

**Missed updates are an error, not a silent outcome.** Two distinct loss conditions are
detected and reported through one callback:

- `history-truncated` — the client reconnected with a cursor older than retained history
- `slow-consumer` — the client could not drain its socket and was disconnected rather
  than left to starve, quietly diverging

```jsx
<PushmountProvider url="/events" onGap={() => queryClient.invalidateQueries()}>
```

Wiring that one prop to a refetch makes stale state *impossible* rather than unlikely.
Nothing else in this category treats it as a first-class concern.

**It is small enough to read.** The entire protocol is two endpoints and one header, all
of it in [PROTOCOL.md](./PROTOCOL.md). The target is that a developer understands the
whole system in ten minutes.

---

## Quickstart

```
pnpm add @pushmount/server @pushmount/client @pushmount/react
```

*(Not yet published — see the notice above. For now: clone, `pnpm install`, `pnpm -r build`.)*

### Server — three additions to an app you already have

```js
import { createHub } from '@pushmount/server'

const hub = createHub()

app.use(session())        // already there
app.use(loadUser)         // already there — sets req.user

// 1. mount the stream, AFTER your auth middleware
app.get('/events', hub.handler({
  authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
  connectionKey: (req) => req.user.id,     // caps connections per user
}))
app.get('/events/cursor', hub.cursorHandler())

// 2. publish from the write path you already have
app.post('/api/orders', async (req, res) => {
  const order = await db.orders.insert(req.body)
  res.json(order)
  hub.publish(`org/${req.user.orgId}/orders`, order)
})

// 3. hand the page a cursor with its data — see "the cold-start window" below
app.get('/api/bootstrap', (req, res) => {
  res.json({ orders: recentOrders, cursor: hub.cursor() })
})
```

Mount order is the entire security model. Everything above the mount has already run, so
`req.user` exists and `authorize` never has to parse a token.

### Client

```jsx
import { PushmountProvider, useTopic } from '@pushmount/react'

<PushmountProvider
  url="/events"
  initialCursor={boot.cursor}
  onGap={() => queryClient.invalidateQueries()}
>
  <App />
</PushmountProvider>
```

```jsx
function Revenue({ initial }) {
  const revenue = useTopic(`org/${orgId}/revenue`, initial)
  return <strong>{format(revenue)}</strong>
}
```

The migration this replaces:

```diff
- const { data } = useQuery({
-   queryKey: ['revenue'], queryFn: fetchRevenue,
-   refetchInterval: 5000,          // 720 requests per hour, per tab
- })
+ const data = useTopic(`org/${orgId}/revenue`, initial)
```

### Collections need a fold, not a cell

`useTopic` is a last-value cell. It is right for a dashboard number or a status, and
wrong for a growing list — an event carries one new order, not the list containing it.

```jsx
const orders = useTopicReducer(
  `org/${orgId}/orders`,
  (list, order) => [order, ...list].slice(0, 50),
  initialOrders,
)
```

---

## Things that will bite you

**The cold-start window.** Between your page reading its data and the browser opening the
stream, anything published is lost — and without a cursor, *nothing reports it*. This is
on every first page load. Pass `hub.cursor()` alongside your initial data and hand it
back as `initialCursor`. It is two lines and it closes the only hole in the gap-detection
story.

**`publish` is not transactional with your database write.** A crash between the two
loses the event with no record that it existed. Every product in this category behaves
this way, but it should be stated rather than discovered. If you truly cannot lose an
event, you need a transactional outbox.

**Your service worker can buffer the stream.** A worker doing
`respondWith(fetch(event.request))` defeats every header the server sets, without
touching your server. If the quickstart hangs and you have a service worker, that is
where to look first.

**HTTP/1.1 costs one of six connections per origin.** One connection per tab, so this is
rarely fatal, but it disappears entirely under HTTP/2 — worth having on before you
measure anything.

**Adding a topic reconnects.** There is no client-to-server channel by design, so a
changed topic set means a new connection carrying the current cursor. Mounts inside one
render pass are debounced into one connection; churning topics on every render is not.

---

## Multiple processes

Skip this if you run one process. Nothing below is needed, and nothing above changes.

Once you run pm2 in cluster mode, several pods, or anything horizontally scaled, a
publish in one process has to reach subscribers in the others. That is what a backplane
does:

```js
import { createRedisBackplane } from '@pushmount/redis'
import Redis from 'ioredis'

const hub = createHub({
  backplane: await createRedisBackplane({
    redis: new Redis(url),
    // A second connection, because XREAD BLOCK monopolises the one it runs on.
    subscriber: new Redis(url),
  }),
})
```

It is built on **Redis Streams**, not pub/sub, and the reason decides everything else:
`XADD` assigns exactly the `<ms>-<seq>` id this protocol uses. So Redis becomes the
sequencer — no per-process counter, no two pods minting the same id, no client silently
discarding a real event as already-seen. The stream doubles as the shared history, which
is what lets a client reconnect to a *different* pod and still be told truthfully
whether it missed anything. Pub/sub would give fan-out and nothing else.

One consequence worth knowing: with a backplane, your own process's publishes also
travel through Redis before reaching your own subscribers. That costs a round trip and
buys an ordering that is identical in every process.

---

## Packages

| package | what it is |
|---|---|
| `@pushmount/server` | The in-process hub and the HTTP handler. Zero dependencies. |
| `@pushmount/client` | Framework-agnostic browser client. Zero dependencies. |
| `@pushmount/react` | Provider and hooks. React 18+ peer only. |
| `@pushmount/fastify` | Fastify adapter. Optional. |
| `@pushmount/redis` | Redis Streams backplane, for multi-process. Optional. |

There is also a Rust protocol core (`core/`) with a C ABI (`abi/`) — see below.

### Why the client is not built on EventSource

`EventSource` cannot read response headers, and the checkpoint that reports missed
updates *is* a header. Gap detection is impossible with it. So the client uses `fetch`
and `ReadableStream` and owns its own frame parser — which is also what lets an
empty-payload event be delivered at all (see PROTOCOL.md §6.4).

---

## Why Rust?

Not for speed.

Measured it. A Rust implementation of the hot path, compiled to wasm and called from
Node, was **slower than plain JavaScript** at realistic payload sizes — the Rust logic
is genuinely 2.2x faster, but marshalling strings across the boundary gives all of it
back and then some (0.65x at 2 KB payloads). Both are two orders of magnitude past what
a busy single-process application needs. The numbers and the method are in
[DECISIONS.md](./DECISIONS.md) D2, including the part where they overturned the plan.

**The reason is one implementation of the rules that must never differ.** A handful of
things in this protocol have to be byte-identical everywhere or the guarantees collapse:

- id assignment, including what happens when the system clock moves backwards
- topic validation — bounded in *bytes*, which every language gets wrong differently
- frame encoding, which is also the defence against payload injection
- the atomicity that makes the checkpoint honest

Written once per language, that is four chances to get each of them subtly wrong. And
this is not hypothetical: the very first run of the conformance corpus caught a real
divergence, where the JavaScript hub measured topic length in UTF-16 code units while
Rust measured UTF-8 bytes. An 86-character Japanese topic is 258 bytes — rejected by one,
accepted by the other, on the exact field whose validation exists to prevent forged
frames. Every language has its own wrong answer for "length".

Rust specifically, because:

- **no runtime to embed.** It links into Node, Python, Go, Ruby or the JVM without
  dragging a garbage collector or a scheduler in with it
- **one C ABI serves everything.** Languages with a native bridge get an idiomatic one;
  everything else can call C
- **the protocol logic carries `#![forbid(unsafe_code)]`.** The part that must be correct
  has no unsafe at all, and that is compiler-enforced rather than a convention

The honest costs: a C ABI cannot be written without unsafe, so there are 33 unsafe sites
in one auditable file — kept small, linted with `unsafe_op_in_unsafe_fn`, and verified in
CI by Miri, which executes those paths hunting for undefined behaviour rather than
trusting review. And each language binding is its own build.

**Node does not use it today.** The TypeScript core ships, because it needs no prebuilds,
no `.node` file and no toolchain, and the definition of done here is "install and go".
The Rust core exists, passes the same corpus, and has been proven complete by running the
entire Node test suite against it — so it is ready for the day a second language arrives.

---

## Roadmap

Dates are absent on purpose; this is ordered by value, not scheduled.

### v0.1 — what exists now (unreleased)

Server, client and React packages. Gap detection with both loss conditions. The
conformance corpus. Fastify adapter. Redis Streams backplane for multi-process. A Rust
core with a C ABI and a Node binding, not shipped.

### v0.2 — reach and ergonomics

- **TanStack Query adapter.** Probably the highest-value item left: it maps topics onto
  query keys so both updates and gaps flow into `invalidateQueries`, which makes adoption
  a two-line change for the largest existing audience.
- **Nest adapter.** Note that Nest's own `@Sse()` decorator cannot be used — it writes
  the response itself, so the checkpoint header is unreachable and gap detection becomes
  impossible. Same reason the client avoids `EventSource`.
- Vue and Svelte clients — thin wrappers over `@pushmount/client`.
- `originId` echoed on frames, so the tab that issued a write can skip its own event
  instead of applying it twice (once from the HTTP response, once from the stream).
- A `revalidate` interval, so a long-lived stream re-checks authorization rather than
  inheriting it once at connect and outliving the session that permitted it.
- Observability: connection count, publish rate, lagged-subscriber count.

### v0.3 — more than one runtime

- Postgres `LISTEN`/`NOTIFY` backplane, for teams who do not want Redis. Note it will
  need its own sequencer, since Postgres has no equivalent of `XADD`'s id.
- A backplane path in the Rust core, which it does not have yet.
- The second language binding — Python via PyO3, or Go via cgo. Python and Ruby deploy
  multi-worker by default, so the backplane is a prerequisite there rather than an
  option.

### v0.4 — the browser side

- **Multi-tab connection sharing** via `BroadcastChannel` leader election. Five tabs is
  currently five connections and five replay scans; one tab holding the stream and
  fanning out fixes it.
- Persistent history — a disk-backed ring, so replay survives a restart.

### v1.0

- The standalone Rust hub, speaking the same wire format, for teams who outgrow
  in-process. `@pushmount/client` works against either unchanged: Node is the on-ramp,
  the binary is the escape hatch.

### Ideas, not commitments

Things worth thinking about that may never happen.

- **Postgres CDC auto-publish.** Watch the write-ahead log and publish on row change, so
  application code stops calling `publish` by hand — and, more interestingly, so
  publication becomes a consequence of the commit rather than a second action that can
  fail alone. That is the honest fix for `publish` not being transactional. It is also a
  bigger project than everything above it combined.
- Binary payloads and per-event compression.
- Wire-format compatibility with Mercure, which is currently free: cursor and id
  semantics already match.
- Prefix or pattern subscriptions, so a changed topic set stops costing a reconnect.

---

## Example

```
cd examples/express-react
pnpm start        # http://localhost:3000
```

A real Express + React app: live revenue, a live order list, a connection indicator, and
a gap banner. It runs `compression()` deliberately, because that is the middleware which
silently buffers hand-rolled SSE. Open it twice, or as `?org=99`, to watch a publish
reach only the subscribers authorized for it.

---

## Contributing

Contributions are welcome, but the protocol is the stable part and the rest is moving.
Read [PROTOCOL.md](./PROTOCOL.md) first, and add a vector to
[the corpus](./conformance/) for anything that touches the wire.

---

## License

Dual-licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](./LICENSE-APACHE))
- MIT license ([LICENSE-MIT](./LICENSE-MIT))

at your option. `SPDX-License-Identifier: MIT OR Apache-2.0`.

This is the Rust ecosystem's convention, and it is here for a reason rather than by
habit: Apache 2.0 carries an express patent grant, which is what a company's legal
review usually wants to see before embedding infrastructure code, while MIT stays
compatible with GPLv2 projects that Apache 2.0 alone would exclude. Offering both means
neither adopter has to argue with anyone.

Unless you state otherwise, any contribution you intentionally submit for inclusion in
this work shall be dual-licensed as above, with no additional terms or conditions.
