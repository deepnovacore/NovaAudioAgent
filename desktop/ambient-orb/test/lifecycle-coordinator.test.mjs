import assert from 'node:assert/strict'
import test from 'node:test'

import { createLifecycleCoordinator } from '../src/main/lifecycle-coordinator.mjs'

test('a lifecycle owner prevents a competing operation from running', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  const coordinator = createLifecycleCoordinator({
    onChange: state => calls.push(state),
  })

  const first = coordinator.run('settings_save', async () => {
    await gate
    return 7
  })

  assert.equal(coordinator.busy, true)
  assert.equal(coordinator.owner, 'settings_save')
  assert.deepEqual(
    await coordinator.run('clear_current', async () => 9),
    { status: 'busy' },
  )

  release()
  assert.deepEqual(await first, { status: 'completed', value: 7 })
  assert.equal(coordinator.busy, false)
  assert.equal(coordinator.owner, null)
  assert.deepEqual(calls, [
    { busy: true, owner: 'settings_save' },
    { busy: false, owner: null },
  ])
})

test('a failed lifecycle operation releases ownership for a later operation', async () => {
  const coordinator = createLifecycleCoordinator()

  await assert.rejects(
    coordinator.run('settings_save', async () => {
      throw new Error('write failed')
    }),
    /write failed/,
  )

  assert.deepEqual(
    await coordinator.run('codex_rescan', async () => 'ok'),
    { status: 'completed', value: 'ok' },
  )
})
