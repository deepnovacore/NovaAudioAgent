import assert from 'node:assert/strict'
import {test} from 'node:test'
import {logicalSwipeDistance, runMobileIos, type MobileIosConfig} from '../src/executors/mobile-ios.js'

test('AutoGLM physical swipe distance converts once to logical coordinates', () => {
  assert.equal(logicalSwipeDistance(600, 3), 200)
  assert.equal(logicalSwipeDistance(200, 1), 200)
  assert.throws(() => logicalSwipeDistance(600, 0))
  assert.throws(() => logicalSwipeDistance(Infinity, 3))
})

test('mobile runner rejects unverified physical devices and pre-cancelled runs before approval', async () => {
  const config: MobileIosConfig = {deviceId: 'unverified', deviceType: 'ios', wdaUrl: 'http://127.0.0.1:8100',
    baseUrl: 'http://127.0.0.1:8000/v1', model: 'stub', modelFamily: 'auto-glm', apiKey: 'stub',
    maxSteps: 3, budgetMs: 1000, lockRoot: '/tmp'}
  const approve = (): Promise<boolean> => { assert.fail('must not request approval') }
  assert.deepEqual(await runMobileIos(config, 'tap', {signal: new AbortController().signal, approve, progress: () => undefined}),
    {code: 'invalid_configuration', steps: 0})
  assert.deepEqual(await runMobileIos(config, 'tap', {signal: AbortSignal.abort(), approve, progress: () => undefined}),
    {code: 'cancelled', steps: 0})
})

test('uncertain device write overrides cancellation and timeout', async () => {
  const {mobileWriteFailure} = await import('../src/executors/mobile-ios.js')
  for (const stopped of [undefined, 'cancelled', 'timeout']) {
    assert.equal(mobileWriteFailure(new Error('cleanup_unknown'), true, stopped), 'cleanup_unknown')
    assert.equal(mobileWriteFailure(new Error('network failed'), false, stopped), 'cleanup_unknown')
  }
  assert.equal(mobileWriteFailure(new Error('needs_user_action'), true), 'needs_user_action')
  assert.equal(mobileWriteFailure(new Error('action_failed'), true, 'cancelled'), 'cancelled')
})
