import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyBackendFailure,
  createBackendDiagnosticCollector,
} from '../src/main/backend-diagnostics.mjs'

test('backend classifier maps only stable public failure classes', () => {
  assert.deepEqual(classifyBackendFailure('manual_path_required'), {
    kind: 'configuration_required', code: 'manual_path_required',
  })
  assert.deepEqual(classifyBackendFailure('authentication_failed'), {
    kind: 'authentication_failed', code: 'authentication_failed',
  })
  assert.deepEqual(classifyBackendFailure('codex_unavailable'), {
    kind: 'unavailable', code: 'codex_unavailable',
  })
  assert.deepEqual(classifyBackendFailure('private exception text'), {
    kind: 'recoverable', code: 'backend_disconnected',
  })
})

test('collector accepts split stable diagnostics and never returns raw stderr', () => {
  const collector = createBackendDiagnosticCollector()
  collector.push('secret=https://user:pass@example.invalid\n[runtime-dia')
  collector.push('gnostic] authentication_failed\nprivate stack')
  assert.equal(collector.code(), 'authentication_failed')
  assert.deepEqual(collector.failure(), {
    kind: 'authentication_failed', code: 'authentication_failed',
  })
  assert.equal(JSON.stringify(collector.failure()).includes('secret'), false)
})

test('collector surfaces safe Codex detail but does not promote it to a startup failure class', () => {
  const collector = createBackendDiagnosticCollector()
  assert.equal(
    collector.push('[runtime-diagnostic] codex_login_status_nonzero\nprivate command output'),
    'codex_login_status_nonzero',
  )
  assert.equal(collector.code(), 'codex_login_status_nonzero')
  assert.deepEqual(collector.failure(), {
    kind: 'recoverable', code: 'backend_disconnected',
  })
  assert.equal(JSON.stringify(collector.failure()).includes('private'), false)
})
