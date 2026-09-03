import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  codexAppServerArgv,
  resolveCodexLaunchProfile,
} from '../src/codex-launch-profile.js'

test('launch profiles resolve ask across every platform without deriving policy from it', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const profile = resolveCodexLaunchProfile({approvalMode: 'ask', project: true, foregroundBroker: true})
    assert.equal(profile.id, 'ask', platform)
    assert.deepEqual(profile.thread, {
      approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: 'nova_audio_agent',
    })
    assert.equal(profile.controller, 'present')
    const argv = codexAppServerArgv(profile).join(' ')
    assert.match(argv, /approval_policy="on-request"/u)
    assert.match(argv, /approvals_reviewer="user"/u)
  }
})

test('launch profiles make headless ask isolated and yolo full access', () => {
  const headless = resolveCodexLaunchProfile({approvalMode: 'ask', project: true, foregroundBroker: false})
  assert.equal(headless.id, 'ask_headless')
  assert.equal(headless.controller, 'absent')
  assert.deepEqual(headless.thread, {
    approvalPolicy: 'never', approvalsReviewer: 'user', permissions: 'nova_audio_agent',
  })
  const headlessArgv = codexAppServerArgv(headless).join(' ')
  assert.match(headlessArgv, /approval_policy="never"/u)
  assert.match(headlessArgv, /approvals_reviewer="user"/u)
  assert.match(headlessArgv, /default_permissions="nova_audio_agent"/u)

  const yolo = resolveCodexLaunchProfile({approvalMode: 'yolo', project: true, foregroundBroker: true})
  assert.equal(yolo.id, 'yolo')
  assert.equal(yolo.controller, 'absent')
  assert.deepEqual(yolo.thread, {
    approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access',
  })
  const argv = codexAppServerArgv(yolo).join(' ')
  assert.match(argv, /approval_policy="never"/u)
  assert.match(argv, /approvals_reviewer="user"/u)
  assert.match(argv, /sandbox_mode="danger-full-access"/u)
  assert.doesNotMatch(argv, /default_permissions|permissions\.nova_audio_agent/u)
})
