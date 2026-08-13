// Spike A — can `fetch` set Last-Event-ID as a request header?
//
// PROTOCOL.md §4.1 lets a client present its cursor either as the `Last-Event-ID`
// request header or as a `last_event_id` query parameter. The query parameter exists
// only because the header may be a forbidden header name under the Fetch spec, in
// which case the browser silently drops it. Silently is the problem: we would ship a
// client that appears to reconnect with a cursor and actually reconnects without one,
// which is exactly the invisible data loss the product claims to eliminate.
//
// This server echoes back whatever headers it actually received, so the browser tells
// us the truth instead of us guessing from the spec.
//
//   node server.mjs        then open http://localhost:8787

import { createServer } from 'node:http'

const PORT = 8787

const page = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>Last-Event-ID settability</title>
<style>
  body { font: 14px ui-monospace, Menlo, monospace; max-width: 46rem; margin: 3rem auto; padding: 0 1rem;
         background: #0d1313; color: #e3eaea; line-height: 1.6; }
  h1 { font-size: 1.1rem; letter-spacing: -.01em; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  td, th { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #26302f; vertical-align: top; }
  th { color: #7f8f8f; font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
  .pass { color: #63b47f; font-weight: 600; }
  .fail { color: #e1798a; font-weight: 600; }
  .ua { color: #7f8f8f; font-size: .8rem; margin-top: 1.5rem; word-break: break-all; }
  code { color: #45bdb2; }
</style>
<h1>Can <code>fetch</code> send <code>Last-Event-ID</code>?</h1>
<p id="status">running…</p>
<table id="out"><thead><tr><th>Case</th><th>Sent</th><th>Server received</th><th>Result</th></tr></thead><tbody></tbody></table>
<p class="ua" id="ua"></p>
<script type="module">
const CURSOR = '1755083412345-7'

const cases = [
  { name: 'Last-Event-ID (canonical case)', header: 'Last-Event-ID', value: CURSOR },
  { name: 'last-event-id (lowercase)',      header: 'last-event-id', value: CURSOR },
  { name: 'Control: X-Cursor',              header: 'X-Cursor',      value: CURSOR },
]

const tbody = document.querySelector('#out tbody')
const results = []

for (const c of cases) {
  let received = null, error = null
  try {
    const res = await fetch('/echo', { headers: { [c.header]: c.value } })
    const body = await res.json()
    received = body.headers['last-event-id'] ?? body.headers[c.header.toLowerCase()] ?? null
  } catch (e) {
    error = String(e)
  }
  const ok = received === c.value
  results.push({ ...c, received, ok, error })
  const tr = document.createElement('tr')
  tr.innerHTML = \`<td>\${c.name}</td><td>\${c.value}</td>
    <td>\${error ? 'threw: ' + error : (received ?? '— dropped —')}</td>
    <td class="\${ok ? 'pass' : 'fail'}">\${ok ? 'PASS' : 'FAIL'}</td>\`
  tbody.appendChild(tr)
}

// Also confirm the query-parameter fallback works, since that is the path we ship
// if the header is unavailable.
const qRes = await fetch('/echo?last_event_id=' + encodeURIComponent(CURSOR))
const qBody = await qRes.json()
const qOk = qBody.query.last_event_id === CURSOR
results.push({ name: 'Fallback: ?last_event_id', ok: qOk })
const tr = document.createElement('tr')
tr.innerHTML = \`<td>Fallback: <code>?last_event_id</code></td><td>\${CURSOR}</td>
  <td>\${qBody.query.last_event_id ?? '—'}</td>
  <td class="\${qOk ? 'pass' : 'fail'}">\${qOk ? 'PASS' : 'FAIL'}</td>\`
tbody.appendChild(tr)

const headerWorks = results[0].ok
document.querySelector('#status').innerHTML = headerWorks
  ? '<span class="pass">Header path is usable.</span> Ship Last-Event-ID as primary.'
  : '<span class="fail">Header is dropped by this browser.</span> Query parameter must be primary.'
document.querySelector('#ua').textContent = navigator.userAgent

// Report to the server so a headless run can read it from stdout.
await fetch('/result', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ua: navigator.userAgent, headerWorks, results }),
})
</script>`

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({
      headers: req.headers,
      query: Object.fromEntries(url.searchParams),
    }))
    return
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const r = JSON.parse(body)
      console.log('\n--- RESULT ---')
      console.log('ua:', r.ua)
      for (const c of r.results) {
        console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.received !== undefined ? `  received=${c.received}` : ''}`)
      }
      console.log('headerWorks:', r.headerWorks)
      console.log('--- END ---\n')
      res.writeHead(204).end()
    })
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
}).listen(PORT, () => console.log(`spike A listening on http://localhost:${PORT}`))
