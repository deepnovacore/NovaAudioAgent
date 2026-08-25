import assert from 'node:assert/strict'
import {cp, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {main} from '../src/cli.js'
import {DEMO_NAMES, runDemo, runDemos} from '../src/demos.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/product/v1')

test('product demo names and all order are stable', async () => {
  assert.deepEqual(DEMO_NAMES, ['async', 'dual-axis', 'timeout', 'proactive', 'all'])
  assert.deepEqual(await runDemos(['all'], fixtureRoot), [
    {name: 'async', passed: true, detail_code: 'async_interleaving_verified'},
    {name: 'dual-axis', passed: true, detail_code: 'dual_axes_verified'},
    {name: 'timeout', passed: true, detail_code: 'timeout_unknown_verified'},
    {name: 'proactive', passed: true, detail_code: 'proactive_selection_verified'},
  ])
})

test('each product demo verifies a distinct real runtime invariant', async () => {
  for (const name of ['async', 'dual-axis', 'timeout', 'proactive'] as const) {
    const result = await runDemo(name, fixtureRoot)
    assert.equal(result.name, name)
    assert.equal(result.passed, true)
    assert.match(result.detail_code, /_verified$/u)
  }
})

test('product demos fail when the runtime evidence for their invariant is mutated', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-product-demo-'))
  t.after(async () => {
    const {rm} = await import('node:fs/promises')
    await rm(root, {recursive: true, force: true})
  })
  await cp(fixtureRoot, root, {recursive: true})

  const asyncExpected = resolve(root, 'demos/scenarios/async-delegate-after-user/expected.json')
  const asyncDocument = JSON.parse(await readFile(asyncExpected, 'utf8')) as {
    applied_events: {kind: string; ts: number}[]
  }
  const handoff = asyncDocument.applied_events.find(event => event.kind === 'handoff')
  assert.ok(handoff)
  handoff.ts = 0.5
  await writeFile(asyncExpected, `${JSON.stringify(asyncDocument)}\n`)
  await assert.rejects(runDemo('async', root), /fixture parity mismatch/u)

  await cp(fixtureRoot, root, {recursive: true, force: true})
  const dualInput = resolve(root, 'demos/scenarios/async-delegate-after-user/input.json')
  const dualDocument = JSON.parse(await readFile(dualInput, 'utf8')) as {
    ports: {fastbrain: {output: {action: {act: string}}}[]}
  }
  dualDocument.ports.fastbrain[0]!.output.action = {act: 'none'}
  await writeFile(dualInput, `${JSON.stringify(dualDocument)}\n`)
  await assert.rejects(runDemo('dual-axis', root), /fixture parity mismatch|unknown dispatch/u)

  await cp(fixtureRoot, root, {recursive: true, force: true})
  const speechOnlyScenario = 'advance-clock-host-before-model'
  await cp(
    resolve(repositoryRoot, `fixtures/runtime/v1/${speechOnlyScenario}`),
    resolve(root, `demos/scenarios/${speechOnlyScenario}`),
    {recursive: true},
  )
  const demosPath = resolve(root, 'demos.json')
  const demosDocument = JSON.parse(await readFile(demosPath, 'utf8')) as {
    cases: {name: string; scenario: string}[]
  }
  const dualCase = demosDocument.cases.find(item => item.name === 'dual-axis')
  assert.ok(dualCase)
  dualCase.scenario = speechOnlyScenario
  await writeFile(demosPath, `${JSON.stringify(demosDocument)}\n`)
  assert.deepEqual(await runDemo('dual-axis', root), {
    name: 'dual-axis', passed: false, detail_code: 'demo_invariant_failed',
  })
})

test('product demo root rejects symlink escape and unknown schema/name', {
  skip: process.platform === 'win32' && 'unprivileged Windows test users cannot create directory symlinks',
}, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-product-root-'))
  const outside = await mkdtemp(resolve(tmpdir(), 'nova-product-outside-'))
  t.after(async () => {
    const {rm} = await import('node:fs/promises')
    await Promise.all([root, outside].map(path => rm(path, {recursive: true, force: true})))
  })
  await cp(fixtureRoot, root, {recursive: true})
  const scenario = resolve(root, 'demos/scenarios/async-delegate-after-user')
  const {rm} = await import('node:fs/promises')
  await rm(scenario, {recursive: true})
  await symlink(outside, scenario)
  await assert.rejects(runDemo('async', root), /inside the product fixture root/u)

  await assert.rejects(runDemos(['unknown' as never], fixtureRoot), /unknown demo/u)
})

test('demo CLI emits only compact stable summary lines', async () => {
  let output = ''
  assert.equal(await main(['demo', 'all'], {
    cwd: repositoryRoot,
    io: {write: text => { output += text }},
  }), 0)
  assert.equal(output, [
    'async PASS async_interleaving_verified',
    'dual-axis PASS dual_axes_verified',
    'timeout PASS timeout_unknown_verified',
    'proactive PASS proactive_selection_verified',
    '',
  ].join('\n'))
  assert.equal(output.includes('memory'), false)
  assert.equal(output.includes('model_views'), false)
})
