<h1 align="center">aghoz</h1>

<p align="center">
  <sub><em>AH-gohz</em> — from the Filipino <em>agos</em>, "flow".</sub>
</p>

<p align="center">
  <strong>Real-time server push for apps that already have a backend.</strong><br>
  Server-Sent Events (SSE) that mount into your existing app as a route — so your own
  authentication runs first, and per-user authorization is one line.<br>
  <sub>Node.js today (Express, Fastify, NestJS, React, Vue, Svelte). The protocol core is Rust behind a C ABI,
  so other languages follow.</sub>
</p>

<p align="center">
  <a href="https://github.com/thinkgrid-labs/aghoz/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/thinkgrid-labs/aghoz/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#license"><img alt="License: MIT OR Apache-2.0" src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg"></a>
  <img alt="Node.js 22 or later" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg">
  <img alt="Zero third-party dependencies" src="https://img.shields.io/badge/third--party%20deps-0-brightgreen.svg">
  <img alt="Status: pre-release, unpublished" src="https://img.shields.io/badge/status-pre--release-orange.svg">
</p>

```js
app.get('/events', hub.handler({
  authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
}))
```

No second service. No token exchange. No CORS.

**aghoz** is a small, dependency-free real-time push library. It ships today for
**Node.js** — **Express**, **Fastify**, **NestJS**, **React**, **Vue** and **Svelte** — and the protocol is specified and
conformance-tested independently of any one runtime, so further languages are a binding
rather than a rewrite. It replaces polling (`refetchInterval`,
`setInterval` + `fetch`) with live server-to-client updates over **Server-Sent Events**,
without the second service that **Mercure** or **Centrifugo** require and without the
client-side database that a sync engine like **ElectricSQL** or **PowerSync** brings.
Missed updates are reported as an error rather than silently lost. Scale past one process
with an optional **Redis Streams** backplane. Written in **TypeScript**, with a **Rust**
protocol core behind a C ABI for other languages.

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
> **The name is settled.** `aghoz` is final — see [DECISIONS.md](./DECISIONS.md) D4. It
> was held provisionally until there was something to decide it on, which is why the
> protocol carries the name nowhere and a test still enforces that.
>
> What *is* real: the protocol is specified in [PROTOCOL.md](./PROTOCOL.md) and enforced
> by a shared [conformance corpus](./conformance/) of 57 vectors that every
> implementation runs; the packages pass 202 tests plus 33 in Rust (11 of the 202 are
> backplane tests that skip themselves without a live Redis — CI provides one); and the
> [example app](./examples/express-react) runs end to end, verified in CI. Every
> significant decision — including the two that were reversed — is recorded with its
> evidence in [DECISIONS.md](./DECISIONS.md).
>
> Please don't build a business on it yet. Do open an issue if you try it.

---

## Contents

- [Why this exists](#why-this-exists)
- [How aghoz compares](#how-aghoz-compares)
- [Read this before installing](#read-this-before-installing)
- [What makes it different](#what-makes-it-different)
- [Quickstart](#quickstart) — [server](#server--three-additions-to-an-app-you-already-have) · [client](#client) · [collections](#collections-need-a-fold-not-a-cell)
- [Things that will bite you](#things-that-will-bite-you)
- [Multiple processes (Redis backplane)](#multiple-processes-redis-backplane)
- [Vue and Svelte](#vue-and-svelte)
- [NestJS](#nestjs)
- [Observability](#observability)
- [Packages](#packages)
- [Why Rust?](#why-rust)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Example app](#example-app)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

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

## How aghoz compares

|  | aghoz | Mercure / Centrifugo | Socket.IO | ElectricSQL / PowerSync / Zero | Hand-rolled SSE |
|---|---|---|---|---|---|
| **Extra service to run** | no — a route in your app | yes | no | yes (sync service) | no |
| **Authorization** | your existing middleware, one function | JWTs scoped to topics, minted by you | your own handshake code | row/shape rules in the sync layer | yours to write |
| **Missed updates** | detected and reported (`onGap`) | reconnect replay, loss not surfaced | at-most-once by default | reconciled by the sync engine | silent |
| **Transport** | SSE over plain HTTP | SSE / WebSocket | WebSocket + fallbacks | WebSocket | SSE |
| **Direction** | server → client only | server → client | bidirectional | bidirectional sync | server → client |
| **Client-side database** | none | none | none | yes | none |
| **Offline / local writes** | no | no | no | yes | no |
| **Multi-process** | optional Redis Streams backplane | built in | Redis adapter | built in | yours to write |
| **Dependencies** | zero | a service + a client | several | a service + a client | zero |

Read that table as scope, not scoring. If you need bidirectional messaging, use
Socket.IO. If you need offline-first local writes, use a sync engine. aghoz is for
the case where the server already knows something and the browser should stop asking.

---

## Read this before installing

**It will not work on serverless.** Vercel, Lambda and Cloudflare Workers cannot hold a
long-lived connection. There is no workaround and none is planned. If that is your
deployment target, stop here.

**Across multiple processes you need a backplane.** By default a `publish` reaches only
that process's subscribers, and aghoz warns at startup when it can tell it is one
worker of several. Add `@aghoz/redis` and the limitation goes away — see
[Multiple processes](#multiple-processes-redis-backplane). Redis is entirely optional;
without it there are no dependencies at all.

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
<AghozProvider url="/events" onGap={() => queryClient.invalidateQueries()}>
```

Wiring that one prop to a refetch makes stale state *impossible* rather than unlikely.
Nothing else in this category treats it as a first-class concern.

**It is small enough to read.** The entire protocol is two endpoints and one header, all
of it in [PROTOCOL.md](./PROTOCOL.md). The target is that a developer understands the
whole system in ten minutes.

---

## Quickstart

```
pnpm add @aghoz/server @aghoz/client @aghoz/react
```

*(Not yet published — see the notice above. For now: clone, `pnpm install`, `pnpm -r build`.)*

### Server — three additions to an app you already have

```js
import { createHub } from '@aghoz/server'

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
import { AghozProvider, useTopic } from '@aghoz/react'

<AghozProvider
  url="/events"
  initialCursor={boot.cursor}
  onGap={() => queryClient.invalidateQueries()}
>
  <App />
</AghozProvider>
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

## Multiple processes (Redis backplane)

Skip this if you run one process. Nothing below is needed, and nothing above changes.

Once you run pm2 in cluster mode, several pods, or anything horizontally scaled, a
publish in one process has to reach subscribers in the others. That is what a backplane
does:

```js
import { createRedisBackplane } from '@aghoz/redis'
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

## Vue and Svelte

Both are thin wrappers over `@aghoz/client`: one connection for the app, and a reactive
value where you render. Neither restates a protocol decision — gap detection, replay and
the cursor all belong to the client.

**Vue 3** (`@aghoz/vue`) — provide once in a root `setup()`, then use composables:

```vue
<script setup>
import { provideAghoz, useTopicReducer } from '@aghoz/vue'

provideAghoz({ url: '/events', initialCursor: props.cursor, onGap: () => refetch() })

// The topic may be a ref or a getter; changing it resubscribes.
const orders = useTopicReducer('org/42/orders', (list, order) => [...list, order], [])
</script>
```

The returned ref is **shallow**, deliberately. A deep one would wrap every payload in a
reactive proxy, so an object you published would not be `===` the object you receive and
any identity check downstream would silently stop working. Payloads arrive whole and are
replaced whole; there is nothing for deep reactivity to do but cost.

**Svelte** (`@aghoz/svelte`) — set the client in context, then use stores:

```svelte
<script>
  import { setAghozClient, topic } from '@aghoz/svelte'
  export let cursor

  setAghozClient({ url: '/events', initialCursor: cursor, onGap: () => refetch() })
  const total = topic('org/42/revenue', 0)
</script>

<p>{$total}</p>
```

These are `svelte/store` readables rather than runes. One package therefore covers Svelte
4 and 5 with no compiler step and no rune syntax pinning it to a major version — and the
lifetime comes free: a readable starts on its first subscriber and tears down after its
last, so `$total` auto-subscription *is* the subscription lifecycle. Nothing to clean up,
and no leak when a component is destroyed.

Every function in both packages accepts an explicit `client`, which is what makes them
usable outside a component — in a plain module, or a test, where injection and Svelte
context cannot be read.

---

## NestJS

```sh
npm install @aghoz/nest
```

**Nest's own `@Sse()` decorator cannot be used, and that is why this package exists.**
`@Sse()` takes an Observable and writes the response itself — it owns the status, the
headers and the framing, and offers no way to add one of your own. So
`last-event-id-checkpoint` (§4.4) is unreachable, and a client can never be told it missed
events. That is the whole point of the library, and it is the same reason
[the client avoids `EventSource`](#why-the-client-is-not-built-on-eventsource).

The adapter takes the response over with `@Res()` instead, which puts Nest in
library-specific mode. It works on **both the Express and Fastify platforms** — on Fastify
the reply is hijacked first, without which Fastify serialises and ends the stream.

```ts
@Module({ imports: [AghozModule.forRoot({ maxHistoryBytes: 16 * 1024 * 1024 })] })
export class AppModule {}
```

Then write the controller yourself, with your own guards on it:

```ts
@Controller('events')
@UseGuards(AuthGuard)
export class EventsController {
  private readonly stream: ReturnType<typeof createAghozHandler>

  constructor(@InjectHub() private readonly hub: AghozHub) {
    // Once, in the constructor — never inside the route method. `revalidateMs` schedules
    // an interval per handler, so one per request leaks a timer per connection.
    this.stream = createAghozHandler(hub, {
      authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
      connectionKey: (req) => req.user.id,
    })
  }

  @Get()
  events(@Req() req: Request, @Res() res: Response) {
    return this.stream(req, res)
  }

  @Get('cursor')
  cursor() {
    return { cursor: this.hub.cursor() }
  }
}
```

**This package deliberately does not mount a controller for you.** A route it registered
would carry none of your `@UseGuards()`, and guards are where a Nest application's
authentication lives — so an auto-mounted stream would be the one route in your app that
bypassed it. The premise here is that your authentication runs *before* the hub sees a
request. You write the controller, and your guards run first.

Two things that will bite you:

- Use a bare `@Res()`. `@Res({ passthrough: true })` leaves Nest in charge of ending the
  response, and it will end it — closing the stream the moment the method returns.
- Build the handler in the constructor, not in the route method.

Config that is not known at import time — a Redis backplane, whose factory is async — uses
`forRootAsync`:

```ts
AghozModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => ({
    backplane: await createRedisBackplane({
      redis: new Redis(config.get('REDIS_URL')),
      subscriber: new Redis(config.get('REDIS_URL')),
    }),
  }),
})
```

The module also closes the hub on `beforeApplicationShutdown`. That hook, rather than
`onApplicationShutdown`, is load-bearing: Nest closes the HTTP server *between* the two,
and `server.close()` waits for open connections to end. An SSE stream never ends on its
own, so a hub still holding subscribers at that point means `app.close()` never resolves.

---

## Observability

`hub.stats()` returns a snapshot of what the hub has done and is doing. It is plain
data, cheap enough to call on a scrape interval, and safe to `JSON.stringify`.

```js
const {
  connections,   // open right now
  opened,        // streams opened, ever
  closed,        // { client, 'slow-consumer', revalidated, evicted, 'hub-closed' }
  rejected,      // { 'bad-request', unauthorized, 'over-capacity', 'authorize-error', unavailable }
  published,     // events this process published
  delivered,     // frames written to subscribers — one publish to ten of them counts ten
  truncated,     // clients told they lost events
  bufferedBytes, // queued on subscriber sockets right now
  uptimeMs,
} = hub.stats()
```

**The two numbers to alert on** are `truncated` and `closed['slow-consumer']`. Everything
else describes load; these two describe loss.

- `truncated` climbing means `maxHistoryBytes` is too small for how long your clients
  actually stay disconnected. Each one is a client that was *told* it missed events —
  correct behaviour, and the whole point of the protocol, but not something you want a
  steady rate of.
- `closed['slow-consumer']` climbing means subscribers cannot keep up with your publish
  rate and §8.2 is dropping them. `bufferedBytes` is the leading indicator: it rises
  first, and drops begin when it reaches `maxBufferBytes`.

Every count is monotonic since `createHub`, and `uptimeMs` comes with it, so **rates are
yours to derive**. Nothing here computes one: any window this library picked would be the
wrong one for someone, and Prometheus, StatsD and OpenTelemetry all derive rates from
counters already.

There is deliberately **no metrics endpoint**. This library's premise is that your
authentication runs before the hub sees a request, and a route mounted by the library
would be the one thing in it that bypassed yours — connection counts and rejection
reasons are a description of your traffic. Mount it yourself:

```js
app.get('/internal/aghoz', requireAdmin, (req, res) => res.json(hub.stats()))
```

One thing absent: how full the history ring is. That is state the Rust core's C ABI does
not expose yet, and `truncated` is the metric that actually matters from that region —
it reports the consequence rather than the cause.

---

## Packages

| package | what it is |
|---|---|
| `@aghoz/server` | The in-process hub and the HTTP handler for Express and Node. Zero dependencies. |
| `@aghoz/client` | Framework-agnostic browser client. Zero dependencies. |
| `@aghoz/react` | React provider and hooks (`useTopic`, `useTopicReducer`). React 18+ peer only. |
| `@aghoz/react-query` | TanStack Query adapter: topics mapped onto query keys, gaps included. Optional. |
| `@aghoz/vue` | Vue 3 composables (`useTopic`, `useTopicReducer`). Vue 3.3+ peer only. |
| `@aghoz/svelte` | Svelte stores (`topic`, `topicReducer`). Svelte 4 and 5, peer only. |
| `@aghoz/fastify` | Fastify adapter. Optional. |
| `@aghoz/nest` | NestJS adapter: DI module plus a handler for your own controller. Express and Fastify platforms. Optional. |
| `@aghoz/redis` | Redis Streams backplane, for multi-process deployments. Optional. |

There is also a Rust protocol core (`core/`) with a C ABI (`abi/`) — see
[Why Rust?](#why-rust).

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

## FAQ

### Is aghoz a WebSocket library?

No. It uses Server-Sent Events over ordinary HTTP, one direction only: server to client.
Writes keep going through the REST or RPC API you already have. If you need the browser
to *send* messages over the same socket, you want WebSockets and probably Socket.IO.

### SSE or WebSockets — which should I use?

If the browser only needs to receive, SSE is the smaller answer: it is plain HTTP, so
your cookies, proxies, load balancers, compression and observability all keep working,
and reconnection with resume is part of the standard rather than something you build.
WebSockets earn their complexity when the client also needs to push, or when you need
binary frames. Most "real-time dashboard" features are receive-only and reach for
WebSockets out of habit.

### Does it work on Vercel, Netlify, AWS Lambda or Cloudflare Workers?

No, and it never will. Those runtimes cannot hold an open connection for the lifetime of
a page. You need a long-lived Node process — a container, a VM, Fly, Render, Railway,
Heroku, your own box. See [Read this before installing](#read-this-before-installing).

### Do I need Redis?

Only if you run more than one process. A single Node process needs nothing at all — zero
dependencies. Under pm2 cluster mode, Kubernetes replicas, or any horizontal scaling, add
`@aghoz/redis`. aghoz warns at startup when it can detect that it is one worker
of several.

### How is this different from Mercure or Centrifugo?

Those are standalone hubs: a separate service that has never seen your user table, so
authorization has to be rebuilt as a token subsystem — minting, scoping, expiry,
rotation, revocation. aghoz is a route inside your app, mounted after your existing
auth middleware, so authorization is a function of the request you already parsed. The
tradeoff is real: a standalone hub scales independently of your app, and aghoz
deliberately does not, until the standalone binary lands. See
[How aghoz compares](#how-aghoz-compares).

### How do I replace `refetchInterval` polling in React Query?

Keep React Query for fetching and cache management; delete the interval and let the
stream invalidate. Wire `onGap` to `queryClient.invalidateQueries()` so a detected gap
refetches instead of leaving stale data on screen. A first-class TanStack Query adapter
that maps topics onto query keys is the top item on the [roadmap](#v02--reach-and-ergonomics).

### What happens if a client misses events while disconnected?

It reconnects with its cursor, and the server replays from history. If the cursor is
older than retained history, or the client was dropped as a slow consumer, that is a
*gap* — reported through `onGap` rather than papered over. This is the whole reason the
project exists; silent staleness is the failure mode hand-rolled SSE hides.

### Does it work with Next.js?

The React client does. The server does not run on Next.js route handlers deployed to a
serverless target, for the reason above. A self-hosted Next.js server (`next start` in a
container) can host the hub in a custom server, or you can keep the hub in the Express
API you already have and point the client at it.

### Is it production ready?

Not yet — see the notice at the top. The protocol is specified and conformance-tested,
the packages pass their suites in CI, and the example app runs end to end, but nothing is
published and the API can change without notice.

---

## Roadmap

Dates are absent on purpose; this is ordered by value, not scheduled.

### v0.1 — what exists now (unreleased)

Server, client and React packages. Gap detection with both loss conditions. The
conformance corpus. Fastify adapter. Redis Streams backplane for multi-process. A Rust
core with a C ABI and a Node binding, not shipped.

### v0.2 — reach and ergonomics

- ~~**TanStack Query adapter.**~~ **Shipped** as `@aghoz/react-query`: topics map onto
  query keys so both updates and gaps flow into `invalidateQueries`, which makes adoption
  a two-line change for the largest existing audience.
- **Nest adapter.** Note that Nest's own `@Sse()` decorator cannot be used — it writes
  the response itself, so the checkpoint header is unreachable and gap detection becomes
  impossible. Same reason the client avoids `EventSource`.
- ~~Vue and Svelte clients — thin wrappers over `@aghoz/client`.~~ — **shipped** as
  `@aghoz/vue` and `@aghoz/svelte`. Vue exposes composables over a shallow ref and
  accepts a reactive topic; Svelte exposes `svelte/store` readables rather than runes, so
  one package covers Svelte 4 and 5 and `$topic` auto-subscription *is* the subscription
  lifecycle.
- ~~`originId` echoed on frames~~ — **shipped** as the `origin` field (PROTOCOL.md §6.0),
  so the tab that issued a write skips its own event instead of applying it twice, once
  from the HTTP response and once from the stream.
- ~~A `revalidate` interval~~ — **shipped** as `handler({ revalidateMs })` with
  `client.reconnect()` alongside it (PROTOCOL.md §4.6), so a long-lived stream re-checks
  authorization rather than inheriting it once at connect and outliving the session that
  permitted it.
- ~~Observability: connection count, publish rate, lagged-subscriber count.~~ —
  **shipped** as [`hub.stats()`](#observability), with closes attributed by cause and
  rejections bucketed by cause, because a total filed under the wrong reason sends you
  after the wrong problem. Counters only; rates are the caller's to derive.

### v0.3 — the adapter foundation

The Rust core and the C ABI are the shared half of a language port. This milestone is
about the *other* half — and the honest accounting is that the two halves are the same
size. The core is ~915 lines and every one of them is pinned by the conformance corpus;
the HTTP layer above it is ~950 lines and the corpus does not reach a single one. Until
that changes, "a binding rather than a rewrite" is a claim about half the work.

- **`ADAPTERS.md`** — the porting contract, plus an `abi/README.md` covering ownership,
  threading and the version check. §4 states its requirements as MUSTs; what it does not
  state is that they have an *order*, and the order is the part that only fails in
  production. Register before you await, register teardown before you await, re-check the
  connection after it, delete from the map before `end()`, never write a frame before the
  headers. Each step names the failure it prevents.
- **Two holes in the C ABI, closed while breaking it is still free.** `ag_append` and
  `ag_encode`, without which a backplane cannot be expressed outside Node — and D3's own
  conclusion was that the backplane is a *prerequisite* for the second binding, since
  Gunicorn, Puma and Swoole are multi-worker by default. So the ABI currently supports
  exactly the one deployment shape that Python, Ruby and PHP never have.
- **A backpressure signal that is not Node-shaped.** §8.2 is fed by
  `res.writableLength` — an absolute queue depth that ASGI, `net/http` and Swoole do not
  offer, because they backpressure by suspending instead. The core should also accept
  bytes-handed-over minus bytes-flushed and do the subtraction itself: one verdict rule,
  two ways of feeding it, both still in Rust.
- **An HTTP conformance suite.** The corpus covers `encode`, `topic`, `origin`,
  `idOrder`, `monotonic` and `checkpoint` — all pure functions of the core, and so all
  already identical everywhere by construction. An adapter can pass 57/57 and still omit
  a header, compute the checkpoint after an interleaved publish, answer 403 where 429
  belongs, or leak a subscriber on abort. This is a black-box scenario corpus driven over
  real HTTP against a small reference app each adapter ships, and it is what turns "write
  your own adapter" from an invitation into a contract. Seed it with the bugs already paid
  for: a publish landing during backplane replay, an abort mid-replay, a deliberate drop
  whose recorded cause must not be `client`.
- **Go via cgo, as the proof.** Not for Go adoption — because Go is the only candidate not
  gated behind the backplane work above (one process, goroutines, no shared log needed to
  be honest), so it is the cheapest way to discover that the checklist is wrong somewhere.
  Better found here than in a stranger's issue tracker.

Postgres `LISTEN`/`NOTIFY`, for teams who do not want Redis, belongs in this era too. It
will need its own sequencer, since Postgres has no equivalent of `XADD`'s id.

### v0.4 — the browser side

- **Multi-tab connection sharing** via `BroadcastChannel` leader election. Five tabs is
  currently five connections and five replay scans; one tab holding the stream and
  fanning out fixes it.
- Persistent history — a disk-backed ring, so replay survives a restart.

### v0.5 — adapters in other languages

Only once v0.3 lands is any of this a claim that can be supported.

- **Python, on FastAPI/Starlette**, as the first officially maintained non-Node adapter.
  Worth separating from "Python support": Uvicorn holds a connection cheaply, while Flask
  on WSGI ties up a synchronous worker for the life of every reader — ten readers is ten
  workers gone. Flask should be documented as unsupported rather than left to be
  discovered. The binding is likely `ctypes`/`cffi` rather than PyO3, for the same reason
  Node ships TypeScript by default: a prebuilt shared library in a pure-Python wheel is
  "install and go", and a build-from-source matrix is not.
- **PHP, narrowed rather than excluded.** D3 said PHP is out; that is right about PHP-FPM
  and `mod_php`, whose request-per-process model cannot hold a connection at all, and
  wrong about PHP. FrankenPHP's worker mode and Laravel Octane on Swoole or RoadRunner are
  mainstream deployment targets that hold connections for the life of a page, and
  `FFI::cdef` is in core — so a binding is a PHP file plus a prebuilt `.so`, with no
  extension to compile. All three are multi-worker, so the backplane is a hard prerequisite
  here as well.
- **Versioning across implementations.** §11's "no version field; a breaking change takes
  a new mount path" is defensible for one implementation you control and untenable across
  adapters you do not. The corpus version bumps whenever a vector's expected value changes,
  each adapter reports the version it passes, and the README carries an adapter table —
  runtime, corpus version, HTTP suite status — which is also the honest place to say which
  ones are maintained here and which are merely listed.

Adapters stay in-tree until at least two non-Node ones exist. ABI and corpus churn is
fastest when one commit can change all of it and CI runs everything.

**Not this, ever: a localhost sidecar** for runtimes that are awkward to bind. It would
work, and it would quietly undo the premise. The argument against Mercure and Centrifugo
is that a hub outside your application has never seen your user table, so authorization
has to be rebuilt as a token subsystem — and a sidecar on `localhost` has exactly the same
blindness. A shorter network hop is not a different architecture. The moment
`authorize(req, topic)` is answered across a socket rather than as a function call, the
thing this library exists to delete is back.

### v1.0

- The standalone Rust hub, speaking the same wire format, for teams who outgrow
  in-process. `@aghoz/client` works against either unchanged: Node is the on-ramp,
  the binary is the escape hatch.

  This is not the sidecar rejected above, and the difference is who chooses it and why. A
  team reaching for the standalone hub has outgrown one process and is accepting the token
  subsystem knowingly, in exchange for scaling the hub independently of the app. A sidecar
  would impose that same cost on someone whose only problem was that their language is
  awkward to bind — paying the price without getting the thing it buys.

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

## Example app

```
cd examples/express-react
pnpm start        # http://localhost:3000
```

A real Express + React app: live revenue, a live order list, a connection indicator, and
a gap banner. It runs `compression()` deliberately, because that is the middleware which
silently buffers hand-rolled SSE. Open it twice, or as `?org=99`, to watch a publish
reach only the subscribers authorized for it.

---

## Documentation

- [PROTOCOL.md](./PROTOCOL.md) — the normative wire format: framing, ids, topics,
  cursors, control frames, the checkpoint header.
- [DECISIONS.md](./DECISIONS.md) — every significant decision with its evidence,
  including the two that were reversed by measurement.
- [conformance/](./conformance/) — the language-neutral vector corpus both the
  TypeScript and Rust implementations run.
- [examples/express-react](./examples/express-react) — the end-to-end example app.

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

---

<sub>Keywords: server-sent events, SSE, real-time, live updates, server push, Node.js,
Express, Fastify, React hooks, TypeScript, WebSocket alternative, replace polling,
pub/sub, Redis Streams, Mercure alternative, Centrifugo alternative, Rust.</sub>
