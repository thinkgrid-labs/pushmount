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

## Read this before installing

**It will not work on serverless.** Vercel, Lambda and Cloudflare Workers cannot hold a
long-lived connection. There is no workaround and none is planned. If that is your
deployment target, stop here.

**Right now it will not work across multiple processes either.** A `publish` in one pod
reaches only that pod's subscribers. Until the Redis backplane lands (v0.3), pushmount is
for single-process deployments. It warns at startup when it can detect clustering.

**It is not a sync engine.** No offline support, no local writes, no CRDT conflict
resolution, no client-side database. If you need those, you want ElectricSQL, PowerSync
or Zero, and you will be happier with them than with a bad imitation. Writes here go
through the API you already have; the stream is one-way.

---

## Why this instead of a hub, or fifteen lines of SSE

**Authorization is inherited, not invented.** A standalone hub — Mercure, Centrifugo — is
a separate process that has never seen your session table. Before one message flows you
need JWT minting, topic scopes, expiry and rotation. Running in-process deletes that
entire subsystem: the answer to "may this user read this topic?" is a function call
against the request you already parsed.

**Missed updates are an error, not a silent outcome.** This is the part hand-rolled SSE
gets wrong, and it is worse than polling, because nothing fails. A client that shows
stale data forever looks healthy. pushmount detects two distinct loss conditions and
reports both through one callback:

- `history-truncated` — the client reconnected with a cursor older than retained history.
- `slow-consumer` — the client could not drain its socket and was disconnected rather
  than left to starve.

```jsx
<PushmountProvider url="/events" onGap={() => queryClient.invalidateQueries()}>
```

That line is why you would choose this over writing the fifteen lines yourself. Nothing
else in this category treats it as a first-class concern.

**It is small enough to read.** The whole protocol is two endpoints and one header, all
of it in [PROTOCOL.md](./PROTOCOL.md).

---

## Quickstart

```
pnpm add @pushmount/server @pushmount/client @pushmount/react
```

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

## Packages

| package | what it is |
|---|---|
| `@pushmount/server` | The in-process hub and the HTTP handler. Zero dependencies. |
| `@pushmount/client` | Framework-agnostic browser client. Zero dependencies. |
| `@pushmount/react` | Provider and hooks. React 18+ peer only. |

### Why the client is not built on EventSource

`EventSource` cannot read response headers, and the checkpoint that reports missed
updates *is* a header. Gap detection is impossible with it. So the client uses `fetch`
and `ReadableStream` and owns its own frame parser — which is also what lets an
empty-payload event be delivered at all (see PROTOCOL.md §6.4).

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

## Status

Pre-release. The protocol is specified and enforced by a shared conformance corpus
([conformance/](./conformance/)); decisions and their evidence are in
[DECISIONS.md](./DECISIONS.md).

Not yet done: the Redis backplane and multi-process support, Fastify and Nest adapters,
Vue and Svelte clients, a TanStack Query adapter, multi-tab connection sharing, and the
standalone Rust hub.
