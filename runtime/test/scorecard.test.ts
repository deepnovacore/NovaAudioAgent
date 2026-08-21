import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {canonicalJson} from '../src/canonical-json.js'
import {main} from '../src/cli.js'
import {
  checkScorecardFixtures,
  evaluateFastBrain,
  evaluateSurrogate,
  type FastBrainSample,
  type SurrogateSample,
} from '../src/scorecard.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/product/v1')

interface ScorecardDocument {
  readonly schema_version: number
  readonly fastbrain: readonly FastBrainSample[]
  readonly surrogate: readonly SurrogateSample[]
  readonly expected: {
    readonly fastbrain: Readonly<Record<string, unknown>>
    readonly surrogate: Readonly<Record<string, unknown>>
  }
}

test('Node scorecard exactly matches every Python-owned finding', async () => {
  const document = JSON.parse(
    await readFile(resolve(fixtureRoot, 'scorecard.json'), 'utf8'),
  ) as ScorecardDocument
  assert.equal(document.schema_version, 1)
  for (const sample of document.fastbrain) {
    assert.equal(
      canonicalJson(evaluateFastBrain(sample)),
      canonicalJson(document.expected.fastbrain[sample.name]),
      sample.name,
    )
  }
  for (const sample of document.surrogate) {
    assert.equal(
      canonicalJson(evaluateSurrogate(sample)),
      canonicalJson(document.expected.surrogate[sample.name]),
      sample.name,
    )
  }
  assert.equal(await checkScorecardFixtures(fixtureRoot), 11)
})

test('external action injection and raw evidence remain findings, never actions', async () => {
  const document = JSON.parse(
    await readFile(resolve(fixtureRoot, 'scorecard.json'), 'utf8'),
  ) as ScorecardDocument
  const sample = document.fastbrain.find(item => item.name === 'search-injected-action-and-raw-reference')
  assert.ok(sample)
  const findings = new Map(evaluateFastBrain(sample).map(item => [item.check, item]))
  assert.equal(findings.get('external_action_injection')?.passed, false)
  assert.equal(findings.get('spoken_raw_reference')?.passed, false)
  assert.equal(findings.get('search_attribution')?.passed, false)
})

test('scorecard rejects non-plain, cyclic, functional, and bigint inputs', () => {
  const base: FastBrainSample = {
    name: 'bad', view: {}, text: '', tool_calls: [], require_dual_axes: false,
  }
  assert.throws(() => evaluateFastBrain({...base, view: new (class View {})() as never}), TypeError)
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  assert.throws(() => evaluateFastBrain({...base, view: cycle}), TypeError)
  assert.throws(() => evaluateFastBrain({...base, view: {bad: () => undefined}}), TypeError)
  assert.throws(() => evaluateFastBrain({...base, view: {bad: 1n}}), TypeError)
})

test('scorecard fixture CLI is read-only and compact', async () => {
  let output = ''
  assert.equal(await main(['scorecard', 'fixture', 'check'], {
    cwd: repositoryRoot,
    io: {write: text => { output += text }},
  }), 0)
  assert.equal(output, 'Node scorecard fixture parity passed: 11 case(s)\n')
  assert.equal(output.includes('prompt'), false)
  assert.equal(output.includes('tests/snapshots'), false)
})

test('runtime scorecard source never consumes rollback test snapshots', async () => {
  const source = await readFile(resolve(repositoryRoot, 'runtime/src/scorecard.ts'), 'utf8')
  assert.equal(source.includes('tests/snapshots'), false)
})
