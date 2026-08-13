// Boots the example app and drives one full round trip: subscribe, write through the
// ordinary API, receive the push.
//
// The definition of done is a developer getting push working in ten minutes from the
// quickstart. If the example stops booting, or the round trip stops closing, that claim
// is already false and every other green check is beside the point.
//
//   node scripts/smoke-example.mjs

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3411
const BASE = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('../examples/express-react/', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
child.stdout.on('data', (c) => (log += c))
child.stderr.on('data', (c) => (log += c))

function fail(message) {
  console.error(`\nFAIL: ${message}\n\n--- example output ---\n${log}`)
  child.kill('SIGKILL')
  process.exit(1)
}

try {
  // Wait for the port rather than for a log line, so a change in wording cannot
  // silently turn this into a sleep.
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100)
    try {
      const res = await fetch(`${BASE}/api/bootstrap`)
      up = res.ok
    } catch {
      /* not listening yet */
    }
  }
  if (!up) fail('example never started listening')

  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json()
  if (typeof boot.cursor !== 'string') fail(`bootstrap did not return a cursor: ${JSON.stringify(boot)}`)
  console.log(`  ok  bootstrap returns data and a cursor (${boot.cursor})`)

  const page = await fetch(`${BASE}/app.js`)
  if (!page.ok) fail(`/app.js returned ${page.status}`)
  console.log(`  ok  client bundle builds (${((await page.text()).length / 1024).toFixed(0)} KB)`)

  // Open the stream, then write through the ordinary API and expect the push.
  const controller = new AbortController()
  const stream = await fetch(`${BASE}/events?topics=${encodeURIComponent('org/42/orders')}`, {
    signal: controller.signal,
  })
  if (!stream.ok) fail(`stream returned ${stream.status}`)
  if (stream.headers.get('content-encoding') !== null) {
    // The example runs compression() on purpose; no-transform is what keeps it off.
    fail('the stream was compressed — no-transform is not being honoured')
  }
  console.log('  ok  stream opens uncompressed through compression middleware')

  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const collect = (async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !received.includes('event: org/42/orders')) {
      const { done, value } = await reader.read()
      if (done) break
      received += decoder.decode(value, { stream: true })
    }
  })()

  await sleep(300)
  const order = await (
    await fetch(`${BASE}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total: 4200 }),
    })
  ).json()

  await collect
  controller.abort()

  if (!received.includes('event: org/42/orders')) fail(`no push received; got: ${JSON.stringify(received)}`)
  if (!received.includes(order.id)) fail(`push did not carry the written order ${order.id}`)
  if (!/^id: \d+-\d+$/m.test(received)) fail('push carried no well-formed id')
  console.log(`  ok  write through /api/orders arrives on the stream (${order.id})`)

  console.log('\nquickstart round trip closes\n')
  child.kill('SIGTERM')
  process.exit(0)
} catch (error) {
  fail(String(error))
}
