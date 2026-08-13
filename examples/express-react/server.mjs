// A complete Express + React app using pushmount. Run it with:
//
//   pnpm start        then open http://localhost:3000
//
// Everything specific to pushmount is marked below. There are three additions to what
// would otherwise be an ordinary Express app, and no new infrastructure.

import express from 'express'
import compression from 'compression'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { createHub } from '@pushmount/server'

const PORT = process.env.PORT ?? 3000

// ── pushmount, 1 of 3: create the hub ────────────────────────────────────────
const hub = createHub({
  maxHistoryBytes: 8 * 1024 * 1024,
  maxBufferBytes: 1024 * 1024,
  onError: (error) => console.error('[pushmount]', error),
})

const app = express()

// Compression is here deliberately: it is the middleware that silently buffers
// hand-rolled SSE, and the reason `no-transform` is a requirement rather than advice.
app.use(compression())
app.use(express.json())

// Stands in for whatever session middleware the host app already has. The point is
// that it runs BEFORE the mount below, so req.user exists by the time pushmount sees
// the request — which is why authorization needs no tokens.
app.use((req, _res, next) => {
  req.user = { id: 'u_1', orgId: req.query.org ?? '42' }
  next()
})

// ── pushmount, 2 of 3: mount the stream ──────────────────────────────────────
app.get(
  '/events',
  hub.handler({
    authorize: (req, topic) => topic.startsWith(`org/${req.user.orgId}/`),
    connectionKey: (req) => req.user.id,
  }),
)
app.get('/events/cursor', hub.cursorHandler())

// ── the app's own state and API — unchanged by pushmount ─────────────────────
const state = { revenue: 41200, orders: [] }
let nextOrder = 918

app.post('/api/orders', (req, res) => {
  const order = {
    id: `ord_${nextOrder++}`,
    total: req.body.total ?? Math.floor(200 + Math.random() * 8000),
    at: new Date().toISOString(),
  }
  state.orders.push(order)
  state.revenue += order.total

  res.json(order)

  // ── pushmount, 3 of 3: publish from the write path you already have ────────
  // After the response, so the caller's latency is unchanged. Note that this is not
  // transactional with the write above: a crash in between loses the event silently.
  hub.publish(`org/${req.user.orgId}/orders`, order)
  hub.publish(`org/${req.user.orgId}/revenue`, state.revenue)
})

// Seeds the page. Returning the cursor alongside the data is what closes the window
// between rendering and the stream opening — see PROTOCOL.md §5.
app.get('/api/bootstrap', (req, res) => {
  res.json({
    orgId: req.user.orgId,
    revenue: state.revenue,
    orders: state.orders.slice(-8),
    cursor: hub.cursor(),
  })
})

// ── static serving; esbuild keeps the example runnable with no build step ─────
let bundle = ''
app.get('/app.js', (_req, res) => {
  res.type('application/javascript').send(bundle)
})
app.get('/', (_req, res) => {
  res.type('html').send(readFileSync(new URL('./index.html', import.meta.url), 'utf8'))
})

const result = await build({
  entryPoints: [new URL('./src/app.jsx', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  write: false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
})
bundle = result.outputFiles[0].text

app.listen(PORT, () => {
  console.log(`\n  example running at http://localhost:${PORT}`)
  console.log(`  a second org (should see nothing from org 42): http://localhost:${PORT}/?org=99\n`)
})
