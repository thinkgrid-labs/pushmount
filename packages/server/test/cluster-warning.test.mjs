// The multi-process warning — the README's first risk, made detectable.
//
// A publish in one worker silently never reaches subscribers in another. Nothing errors,
// nothing retries, and it looks exactly like an application bug. Detecting it at startup
// is the difference between a five-minute fix and a lost afternoon.
//
// Runs in child processes so the environment is genuinely isolated per case.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const CWD = new URL('..', import.meta.url).pathname

/** Creates a hub in a child process and returns whatever it passed to console.warn. */
function warningFor(env, hubOptions = '{}') {
  const script = `
    let captured = ''
    console.warn = (...args) => { captured += args.join(' ') }
    const m = await import('./dist/index.js')
    m.createHub(${hubOptions})
    process.stdout.write(captured)
  `
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: CWD,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const SINGLE = { NODE_UNIQUE_ID: '', pm_id: '', NODE_APP_INSTANCE: '', WEB_CONCURRENCY: '' }

test('warns when node:cluster is detected', () => {
  const warning = warningFor({ ...SINGLE, NODE_UNIQUE_ID: '3' })
  assert.match(warning, /node:cluster/)
  assert.match(warning, /only THIS process/)
})

test('warns under pm2, by either marker', () => {
  assert.match(warningFor({ ...SINGLE, pm_id: '0' }), /pm2/)
  assert.match(warningFor({ ...SINGLE, NODE_APP_INSTANCE: '1' }), /pm2/)
})

test('warns when WEB_CONCURRENCY exceeds one, but not when it is one', () => {
  assert.match(warningFor({ ...SINGLE, WEB_CONCURRENCY: '4' }), /WEB_CONCURRENCY/)
  assert.equal(warningFor({ ...SINGLE, WEB_CONCURRENCY: '1' }), '', 'one worker is not a cluster')
})

test('stays quiet in an ordinary single process', () => {
  // The default path must not cry wolf, or the warning stops being read at all.
  assert.equal(warningFor(SINGLE), '')
})

test('suppressClusterWarning silences it', () => {
  const warning = warningFor(
    { ...SINGLE, NODE_UNIQUE_ID: '3' },
    '{ suppressClusterWarning: true }',
  )
  assert.equal(warning, '')
})
