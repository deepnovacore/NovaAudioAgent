import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { canonicalJson } from '../src/canonical-json.js'
import { checkRuntimeFixtures, main, runDeterministicDemo } from '../src/cli.js'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const fixtureRoot = resolve(repositoryRoot, 'fixtures/runtime/v1')

test('Node CLI fixture check runs every committed scenario', async () => {
  assert.equal(await checkRuntimeFixtures(fixtureRoot), 20)

  let output = ''
  assert.equal(await main(['fixture', 'check'], {
    cwd: repositoryRoot,
    io: {write: text => { output += text }},
  }), 0)
  assert.equal(output, 'Node fixture parity passed: 20 scenario(s)\n')
})

test('Node CLI demo emits a verified deterministic runtime snapshot', async () => {
  const snapshot = await runDeterministicDemo(fixtureRoot, 'async-delegate-after-user')
  assert.equal(snapshot.executor_effects[0]?.kind, 'dispatch')
  assert.ok(snapshot.applied_events.some(event => event.kind === 'handoff'))

  let output = ''
  assert.equal(await main(['demo', 'floor-defer-preempt'], {
    cwd: repositoryRoot,
    io: {write: text => { output += text }},
  }), 0)
  assert.equal(output, `${canonicalJson(await runDeterministicDemo(
    fixtureRoot,
    'floor-defer-preempt',
  ))}\n`)
})

test('Node CLI demo rejects a scenario symlink that escapes the fixture root', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'nova-fixture-root-'))
  const outside = await mkdtemp(resolve(tmpdir(), 'nova-fixture-outside-'))
  await mkdir(resolve(root, 'v1'))
  await symlink(outside, resolve(root, 'v1', 'escaped'))
  t.after(async () => {
    const {rm} = await import('node:fs/promises')
    await Promise.all([root, outside].map(async path => rm(path, {recursive: true, force: true})))
  })

  await assert.rejects(
    runDeterministicDemo(resolve(root, 'v1'), 'escaped'),
    /stay inside/u,
  )
})
