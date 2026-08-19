// Show where the Node replay of one session scenario diverges from its Python golden.
// Usage: node runtime/scripts/diff-session-fixture.mjs <scenario-id>
import { resolve } from 'node:path'
import { canonicalJson } from '../dist/src/canonical-json.js'
import { loadSessionFixture } from '../dist/src/realtime/session-fixtures.js'
import { runSessionFixture } from '../dist/test/session-fixture-host.js'

const scenario = process.argv[2]
if (scenario === undefined) throw new Error('pass a scenario id')
const directory = resolve(import.meta.dirname, '../../fixtures/realtime/session/v1', scenario)

const fixture = await loadSessionFixture(directory)
const actual = await runSessionFixture(fixture)
if (canonicalJson(actual) === canonicalJson(fixture.expected)) {
  console.log(`${scenario}: identical`)
  process.exit(0)
}

const expectedSteps = fixture.expected.observations
const actualSteps = actual.observations
for (let index = 0; index < Math.max(expectedSteps.length, actualSteps.length); index += 1) {
  const want = expectedSteps[index]
  const got = actualSteps[index]
  if (canonicalJson(want) === canonicalJson(got)) continue
  console.log(`\n=== step ${index} (${want?.kind ?? got?.kind}) ===`)
  for (const key of new Set([...Object.keys(want ?? {}), ...Object.keys(got ?? {})])) {
    const a = canonicalJson(want?.[key] ?? null)
    const b = canonicalJson(got?.[key] ?? null)
    if (a === b) continue
    if (key === 'state') {
      for (const field of new Set([
        ...Object.keys(want?.state ?? {}),
        ...Object.keys(got?.state ?? {}),
      ])) {
        const x = canonicalJson(want?.state?.[field] ?? null)
        const y = canonicalJson(got?.state?.[field] ?? null)
        if (x === y) continue
        console.log(`  state.${field}:\n    python: ${x}\n    node:   ${y}`)
      }
      continue
    }
    console.log(`  ${key}:\n    python: ${a}\n    node:   ${b}`)
  }
}
