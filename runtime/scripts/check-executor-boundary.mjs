/**
 * Executor boundary check (spec 07, "Enforcement").
 *
 * Core -- `runtime/src/**` minus `executors/**` and the composition roots -- must not name a
 * concrete executor. Every hit of the pattern below must be listed in
 * `executor-boundary-allowlist.json` with a reason; anything else fails `npm run check`.
 *
 *   node runtime/scripts/check-executor-boundary.mjs --check
 */
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const PATTERN = /codex/giu
const COMPOSITION_ROOTS = new Set([
  'runtime/src/cli.ts',
  'runtime/src/desktop-entry.ts',
  'runtime/src/production-composition.ts',
  'runtime/src/production-realtime-assembly.ts',
])

const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(runtimeRoot, '..')
const allowlistPath = resolve(runtimeRoot, 'scripts/executor-boundary-allowlist.json')

function walk(directory, out) {
  for (const entry of readdirSync(directory)) {
    const path = `${directory}/${entry}`
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

export function coreFiles() {
  return walk(resolve(runtimeRoot, 'src'), [])
    .map(path => relative(repositoryRoot, path).split('\\').join('/'))
    .filter(path => !path.startsWith('runtime/src/executors/') && !COMPOSITION_ROOTS.has(path))
    .sort()
}

/** Every hit as `{path, line, match}`; the allowlist matches on `path` + `pattern` (the exact trimmed source line). */
export function scanCore() {
  const hits = []
  for (const path of coreFiles()) {
    const lines = readFileSync(resolve(repositoryRoot, path), 'utf8').split('\n')
    lines.forEach((text, index) => {
      for (const match of text.matchAll(PATTERN)) hits.push({path, line: index + 1, match: match[0], text})
    })
  }
  return hits
}

function entryBudget(allowlist) {
  return allowlist.map(entry => ({
    entry,
    remaining: typeof entry.count === 'number' && entry.count > 0 ? entry.count : 1,
  }))
}

export function unlistedHits(hits, allowlist) {
  const budgets = entryBudget(allowlist)
  const unlisted = []
  for (const hit of hits) {
    let covered = false
    for (const budget of budgets) {
      if (budget.remaining <= 0) continue
      const entry = budget.entry
      if (entry.path !== hit.path || hit.text.trim() !== entry.pattern) continue
      budget.remaining -= 1
      covered = true
      break
    }
    if (!covered) unlisted.push(hit)
  }
  return unlisted
}

export function staleEntries(hits, allowlist) {
  const budgets = entryBudget(allowlist)
  for (const hit of hits) {
    for (const budget of budgets) {
      if (budget.remaining <= 0) continue
      const entry = budget.entry
      if (entry.path !== hit.path || hit.text.trim() !== entry.pattern) continue
      budget.remaining -= 1
      break
    }
  }
  return budgets.filter(budget => budget.remaining > 0).map(budget => budget.entry)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--check') {
    process.stderr.write('Usage: node runtime/scripts/check-executor-boundary.mjs --check\n')
    process.exitCode = 2
  } else {
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
    for (const entry of allowlist) {
      if (typeof entry.path !== 'string' || typeof entry.pattern !== 'string' || typeof entry.reason !== 'string'
        || entry.pattern === '' || entry.reason === ''
        || (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count < 1))) {
        throw new Error('invalid executor boundary allowlist entry')
      }
    }
    const hits = scanCore()
    const unlisted = unlistedHits(hits, allowlist)
    const stale = staleEntries(hits, allowlist)
    for (const hit of unlisted) process.stderr.write(`executor boundary: ${hit.path}:${hit.line}: ${hit.match}\n`)
    for (const entry of stale) process.stderr.write(`executor boundary: stale allowlist entry ${entry.path} ${JSON.stringify(entry.pattern)}\n`)
    if (unlisted.length > 0 || stale.length > 0) {
      process.exitCode = 1
    } else {
      process.stdout.write(`Executor boundary passed: ${hits.length} allowlisted occurrences\n`)
    }
  }
}
