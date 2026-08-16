// The Node reference app for the HTTP conformance suite.
//
// Every adapter ships one of these. It is the smallest server that exposes the two
// protocol endpoints plus the control surface the harness needs to put a hub into a known
// state — see ../../README.md for the contract this implements.
//
// Nothing here is clever on purpose. An adapter's test app should read as the plainest
// possible use of its own API, because a scenario failing must mean the adapter is wrong,
// not that the test app was.

import { createServer } from 'node:http'
// A relative import rather than `@aghoz/server`, so this directory needs no package.json
// and no workspace entry. An adapter in another language imports its own package here;
// the contract is the HTTP surface below, not how the app got hold of the library.
import { createHub } from '../../../../packages/server/dist/index.js'

// ---------------------------------------------------------------- hub lifecycle

/** Fixed by the harness so ids are deterministic and frames compare byte-for-byte. */
let clock = 1000
let hub = null
let handler = null
let cursorHandler = null

/**
 * A backplane whose replay is slow on purpose.
 *
 * Only installed when a scenario asks for it. This is what widens §4.5's atomic block far
 * enough to aim at: with no backplane the block has no `await` in it and a connection goes
 * from registered to fully open in one tick, so none of the window bugs are reachable.
 */
function slowBackplane(delayMs) {
  let sink = () => {}
  let seq = 0
  return {
    publish: async (topic, payload, origin) => {
      const id = `${clock}-${seq++}`
      queueMicrotask(() => sink({ id, topic, payload, ...(origin !== undefined && { origin }) }))
      return id
    },
    onEvent: (fn) => {
      sink = fn
    },
    replay: async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      return { truncated: false, events: [] }
    },
    cursor: async () => `${clock}-0`,
    close: async () => {},
  }
}

/**
 * Rebuilds the hub. One process serves the whole run, so every scenario starts from a
 * hub that remembers nothing of the last one.
 */
async function reset(config = {}) {
  if (hub !== null) hub.close()
  clock = config.clock ?? 1000

  const options = {
    now: () => clock,
    // Off unless a scenario asks, so a stray `:ka` cannot make an unrelated frame
    // assertion flaky.
    keepAliveMs: config.keepAliveMs ?? 0,
    suppressClusterWarning: true,
  }
  for (const key of [
    'maxHistoryBytes',
    'maxBufferBytes',
    'maxConnections',
    'maxConnectionsPerKey',
    'maxTopicsPerConnection',
  ]) {
    if (config[key] !== undefined) options[key] = config[key]
  }
  if (config.backplaneDelayMs !== undefined) {
    options.backplane = slowBackplane(config.backplaneDelayMs)
  }

  hub = createHub(options)
  handler = hub.handler({
    authorize,
    connectionKey: (req) => header(req, 'x-t-key') ?? undefined,
    ...(config.revalidateMs !== undefined && { revalidateMs: config.revalidateMs }),
  })
  cursorHandler = hub.cursorHandler()
}

/**
 * §4.3, driven by a request header rather than by configuration.
 *
 * Per-request so one handler serves every scenario: `authorize` sees the request, which is
 * the whole premise of the library, so the rule can travel on the request too.
 *
 *   all           — permit everything (the default)
 *   none          — deny everything
 *   prefix:<p>    — permit topics starting with <p>
 *   throw         — raise, to exercise the 500 and the fail-closed revalidation path
 */
function authorize(req, topic) {
  const rule = header(req, 'x-t-authorize') ?? 'all'
  if (rule === 'all') return true
  if (rule === 'none') return false
  if (rule === 'throw') throw new Error('authorize blew up')
  if (rule.startsWith('prefix:')) return topic.startsWith(rule.slice('prefix:'.length))
  throw new Error(`unknown authorize rule: ${rule}`)
}

function header(req, name) {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

// ---------------------------------------------------------------------- routing

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]

  // ---- the control surface ------------------------------------------------
  if (path.startsWith('/_t/')) {
    void (async () => {
      try {
        switch (path) {
          case '/_t/reset':
            await reset(await body(req))
            return json(res, 200, { ok: true })
          case '/_t/clock':
            clock = (await body(req)).ms
            return json(res, 200, { ok: true })
          case '/_t/publish': {
            const { topic, payload, origin } = await body(req)
            const ack = await hub.publish(topic, payload, origin === undefined ? {} : { origin })
            return json(res, 200, ack)
          }
          case '/_t/stats':
            return json(res, 200, hub.stats())
          case '/_t/disconnect': {
            // The push half of §4.6 — evicts by connection key.
            const { key } = await body(req)
            const n = hub.disconnect((r) => header(r, 'x-t-key') === key)
            return json(res, 200, { disconnected: n })
          }
          case '/_t/close':
            hub.close()
            return json(res, 200, { ok: true })
          default:
            return json(res, 404, { error: 'no such control endpoint' })
        }
      } catch (error) {
        // A control failure must be distinguishable from a protocol failure, or a broken
        // test app reads as a failing scenario.
        json(res, 500, { error: String(error?.message ?? error) })
      }
    })()
    return
  }

  // ---- the protocol -------------------------------------------------------
  if (path === '/events/cursor') return cursorHandler(req, res)
  if (path === '/events') {
    // A rejected handler promise means the response was already written to by something
    // else — exactly the class of bug this suite exists to catch, so it is surfaced
    // rather than swallowed.
    return void handler(req, res).catch((error) => {
      process.stderr.write(`handler rejected: ${error?.stack ?? error}\n`)
    })
  }
  json(res, 404, { error: 'not found' })
})

await reset()
server.listen(0, () => {
  // The harness reads this line to learn the port. It must be the first thing on stdout.
  process.stdout.write(`listening ${server.address().port}\n`)
})
