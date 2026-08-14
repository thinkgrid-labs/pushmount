// Repository invariants that no unit test would naturally catch, and that decay
// silently if nothing enforces them.
//
//   node scripts/check-invariants.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const failures = []

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures.push({ label, message: error.message })
    console.error(`  FAIL  ${label}\n          ${error.message}`)
  }
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

function json(path) {
  return JSON.parse(read(path))
}

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`
    if (entry === 'node_modules' || entry === 'dist' || entry === 'target' || entry === '.git') continue
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

// Derived, not listed. A hardcoded list silently stops checking the moment a package
// is added — which is exactly what had happened: `fastify` and `redis` were never
// covered by the dependency or lockstep invariants below.
const PACKAGES = readdirSync(join(ROOT, 'packages'))
  .map((entry) => `packages/${entry}`)
  .filter((rel) => statSync(join(ROOT, rel)).isDirectory())
  .sort()

console.log('\nrepository invariants\n')

// ---------------------------------------------------------------------------
check('the product name never appears on the wire', () => {
  // DECISIONS.md D0 defers the name, and that is only affordable while renaming stays
  // a find-and-replace. The moment a header, event name or field carries the name,
  // every deployed client pins it forever.
  const name = json('package.json').name.replace(/-workspace$/, '')
  const wireish = /(?:^|[^\w])(?:id|event|data|retry):|headers?\[|writeHead\(|setHeader\(/

  const offenders = []
  for (const pkg of PACKAGES) {
    for (const file of walk(`${pkg}/src`)) {
      const source = read(file)
      for (const [i, line] of source.split('\n').entries()) {
        // Only literal strings matter; prose in comments is fine.
        const strings = line.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []
        if (!strings.some((s) => s.toLowerCase().includes(name))) continue
        if (!wireish.test(line) && !/['"`][a-z-]*-?cursor|checkpoint/i.test(line)) continue
        offenders.push(`${file}:${i + 1}`)
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`name appears in wire-adjacent literals: ${offenders.join(', ')}`)
  }
  return `"${name}" absent from all wire literals`
})

// ---------------------------------------------------------------------------
check('shipped packages declare no third-party runtime dependencies', () => {
  // The whole install story rests on this. A single transitive dependency turns
  // "npm install and go" into a supply-chain conversation.
  const offenders = []
  for (const pkg of PACKAGES) {
    const manifest = json(`${pkg}/package.json`)
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@pushmount/')) offenders.push(`${manifest.name} → ${dep}`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join(', '))
  return 'workspace-internal only'
})

// ---------------------------------------------------------------------------
check('packages version in lockstep', () => {
  // The conformance guarantee is only real if the packages that share the corpus ship
  // together. Divergent versions make "these agree" an untestable claim.
  const versions = new Map()
  for (const pkg of PACKAGES) {
    const manifest = json(`${pkg}/package.json`)
    versions.set(manifest.name, manifest.version)
  }
  const distinct = new Set(versions.values())
  if (distinct.size !== 1) {
    throw new Error(
      `versions diverge: ${[...versions].map(([n, v]) => `${n}@${v}`).join(', ')}`,
    )
  }
  return `all at ${[...distinct][0]}`
})

// ---------------------------------------------------------------------------
check('the protocol core performs no IO', () => {
  // hub.ts and registry.ts are what the corpus owns. Once they can touch a socket or
  // the clock, the corpus stops being able to pin their behaviour.
  const offenders = []
  for (const file of ['packages/server/src/hub.ts', 'packages/server/src/registry.ts']) {
    const source = read(file)
    for (const pattern of [/from 'node:/, /require\(/, /Date\.now\(/, /Math\.random\(/]) {
      if (pattern.test(source)) offenders.push(`${file} contains ${pattern}`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '))
  return 'hub.ts and registry.ts are pure'
})

// ---------------------------------------------------------------------------
check('the client has no dependency on the server package', () => {
  // They are tested against each other, but a runtime edge would defeat the point of
  // the corpus: the two implementations must be independently correct.
  const manifest = json('packages/client/package.json')
  const runtime = Object.keys(manifest.dependencies ?? {})
  if (runtime.includes('@pushmount/server')) {
    throw new Error('@pushmount/client must not depend on the server at runtime')
  }
  return 'independent'
})

// ---------------------------------------------------------------------------
check('every conformance vector carries a description', () => {
  // A vector whose failure message does not say what is wrong is worth very little at
  // three in the morning.
  const corpus = json('conformance/vectors.json')
  const missing = []
  for (const group of ['encode', 'topic', 'idOrder', 'monotonic']) {
    for (const vector of corpus[group]) {
      if (typeof vector.desc !== 'string' || vector.desc.length < 8) {
        missing.push(`${group}/${vector.id}`)
      }
    }
  }
  if (missing.length > 0) throw new Error(`undescribed vectors: ${missing.join(', ')}`)
  const total = ['encode', 'topic', 'idOrder', 'monotonic'].reduce(
    (n, g) => n + corpus[g].length,
    0,
  )
  return `${total} vectors`
})

// ---------------------------------------------------------------------------
check('the README states the exclusions before the install line', () => {
  // Serverless and multi-process are the two ways someone wastes an afternoon before
  // discovering this is the wrong tool. They belong above the fold, permanently.
  const readme = read('README.md')
  const install = readme.indexOf('pnpm add')
  if (install === -1) throw new Error('no install instruction found')
  const head = readme.slice(0, install)
  for (const term of ['serverless', 'multiple processes', 'sync engine']) {
    if (!head.toLowerCase().includes(term)) {
      throw new Error(`"${term}" must appear before the install instruction`)
    }
  }
  return 'serverless, multi-process and sync-engine all disclosed above the fold'
})

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} invariant(s) violated\n`)
  process.exit(1)
}
console.log('all invariants hold\n')
