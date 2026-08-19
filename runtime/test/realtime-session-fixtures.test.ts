import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  loadSessionFixture,
  sessionFixtureJsonSchema,
  type SessionFixture,
} from '../src/realtime/session-fixtures.js'

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
  // These fixtures land before the ported reducer, so for a while Python is the only leg checking
  // the goldens. The marker says so. The moment a session reducer exists here, this fails until
  // every marker is cleared -- because a green build that checks nothing must not read as parity.
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
