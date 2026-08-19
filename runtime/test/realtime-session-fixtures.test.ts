import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import {
  loadSessionFixture,
  sessionFixtureJsonSchema,
  sessionFixtureStepSchema,
  type SessionFixture,
} from '../src/realtime/session-fixtures.js'
import { runSessionFixture } from './session-fixture-host.js'

// The test runs as runtime/dist/test/*.js, so three levels up is the repository root.
const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/realtime/session/v1')

function scenarioDirectories(): string[] {
  return readdirSync(fixtureRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(fixtureRoot, entry.name))
    .sort()
}

async function loadAll(): Promise<SessionFixture[]> {
  return Promise.all(scenarioDirectories().map(directory => loadSessionFixture(directory)))
}

test('the committed schema matches the Zod contract it is generated from', () => {
  // Regenerate with `npm run fixtures:schema:session`. The Python oracle validates every fixture
  // against these bytes, so drift here means the two legs disagree about what a fixture may say.
  const committed: unknown = JSON.parse(
    readFileSync(resolve(fixtureRoot, 'schema.json'), 'utf8'),
  )
  assert.deepEqual(committed, sessionFixtureJsonSchema())
})

test('every committed scenario parses against the contract', async () => {
  // This is what the Node leg proves today: it reads the same bytes Python exported and the
  // contract accepts them. Checking the goldens themselves needs the ported reducer.
  const fixtures = await loadAll()
  assert.ok(fixtures.length > 0, 'there must be scenarios to check')
})

test('every scenario says what it covers and observes every step it scripts', async () => {
  for (const fixture of await loadAll()) {
    const {id, covers} = fixture.manifest
    assert.ok(covers.length > 0, `${id} must say what it covers`)
    assert.ok(fixture.input.steps.length > 0, `${id} must script at least one step`)
    assert.equal(
      fixture.expected.observations.length,
      fixture.input.steps.length,
      `${id} must observe every step`,
    )
    for (const [index, observation] of fixture.expected.observations.entries()) {
      assert.equal(observation.step, index, `${id} observation ${index} is out of order`)
      assert.equal(
        observation.kind,
        fixture.input.steps[index]!.kind,
        `${id} observation ${index} does not name the step it observed`,
      )
    }
  }
})

test('every step kind the contract allows is exercised by some scenario', async () => {
  // A step kind in the contract that no scenario sends is a hole that does not announce itself:
  // `playback_stopped` sat unported behind exactly this gap while every golden passed. The
  // contract is the list of things this harness claims to cover, so it has to be covered.
  const declared = new Set(
    sessionFixtureStepSchema.options.map(option => option.shape.kind.value),
  )
  const used = new Set<string>()
  for (const fixture of await loadAll()) {
    for (const step of fixture.input.steps) used.add(step.kind)
  }
  assert.deepEqual(
    [...declared].filter(kind => !used.has(kind)).sort(),
    [],
    'these step kinds are in the contract but no scenario sends one',
  )
})

test('a scenario declares the synthetic capabilities it uses, and no others', async () => {
  for (const fixture of await loadAll()) {
    const usesFill = fixture.input.steps.some(
      step => 'event' in step && 'pcm' in step.event && 'pcm_fill' in step.event.pcm,
    )
    const declared = fixture.manifest.requires.includes('pcm_fixture')
    assert.equal(
      declared,
      usesFill,
      `${fixture.manifest.id}: requires and pcm_fill usage must agree`,
    )
  }
})

test('the pending-parity marker cannot outlive the reducer that has to satisfy it', async () => {
  // A scenario the Node leg does not check must say so. Once the reducer exists, every marker has
  // to be cleared, because a green build that checks nothing must not read as parity.
  const runtime: Record<string, unknown> = await import('../src/index.js')
  if (!('RealtimeSession' in runtime)) return

  const pending = (await loadAll())
    .filter(fixture => fixture.manifest.node_parity === 'pending-session-port')
    .map(fixture => fixture.manifest.id)
  assert.deepEqual(
    pending,
    [],
    'RealtimeSession is ported: these scenarios must now be checked on both legs',
  )
})

test('every checked scenario matches the Python-exported golden', async () => {
  // The whole point of the family: the same committed bytes, replayed through the real session.
  // Compared as canonical JSON so key order and number spelling cannot mask a real difference.
  const checked = (await loadAll()).filter(
    fixture => fixture.manifest.node_parity === 'checked',
  )
  assert.ok(checked.length > 0, 'at least one scenario must be checked on both legs')

  // Collect every mismatch rather than stopping at the first: one divergence in a shared helper
  // shows up in several scenarios, and seeing which ones is most of the diagnosis.
  const mismatched: string[] = []
  for (const fixture of checked) {
    let actual: unknown
    try {
      actual = await runSessionFixture(fixture)
    } catch (cause) {
      mismatched.push(`${fixture.manifest.id} (threw: ${String(cause)})`)
      continue
    }
    if (canonicalJson(actual) !== canonicalJson(fixture.expected)) {
      mismatched.push(fixture.manifest.id)
    }
  }
  assert.deepEqual(
    mismatched,
    [],
    'Node output differs from the Python golden; '
      + 'run `node runtime/scripts/diff-session-fixture.mjs <id>` for the first difference',
  )
})
