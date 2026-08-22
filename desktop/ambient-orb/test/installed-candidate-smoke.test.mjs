import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

import {
  CAMERA_CAPABILITY_PENDING,
  RELEASE_SMOKE_MODE,
  candidateInstallPlan,
  classifyCameraCapability,
  smokeEnvironment,
} from '../scripts/installed-candidate-smoke.mjs'

test('installed candidate plans use native install or mount boundaries for every closed artifact', () => {
  const root = '/private/smoke'
  const matrix = [
    ['darwin-arm64:app', 'nova-darwin-arm64-app.zip', '/private/smoke/install/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/install'],
    ['darwin-arm64:dmg', 'nova-darwin-arm64.dmg', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb'],
    ['darwin-x64:app', 'nova-darwin-x64-app.zip', '/private/smoke/install/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/install'],
    ['darwin-x64:dmg', 'nova-darwin-x64.dmg', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb'],
    ['win32-x64:nsis', 'nova-win32-x64.exe', '/private/smoke/install/Nova Audio Agent Ambient Orb.exe', '/private/smoke/install'],
    ['linux-x64-gnu:appimage', 'nova-linux-x64.AppImage', '/private/smoke/install/squashfs-root/AppRun', '/private/smoke/install'],
    ['linux-x64-gnu:deb', 'nova-linux-x64.deb', '/usr/bin/nova-ambient-orb', '/usr/bin/nova-ambient-orb'],
  ]
  for (const [target, artifactName, executable, residue] of matrix) {
    const plan = candidateInstallPlan({target, artifact: `${root}/${artifactName}`, scratch: root})
    assert.equal(plan.executable, executable)
    assert.ok(plan.install.length > 0)
    assert.ok(plan.uninstall.length > 0)
    assert.deepEqual(plan.residue, [residue])
    assert.equal(JSON.stringify(plan).includes('python'), false)
    assert.equal(Object.isFrozen(plan), true)
  }
})

test('installed source rollback accepts only the stable diagnostic with no readiness or backend output', async () => {
  const {classifySourceRollbackResult} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.deepEqual(classifySourceRollbackResult({
    status: 0,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '[desktop-diagnostic] source_rollback_unavailable\n',
    readiness: Buffer.alloc(0),
  }), {status: 'passed'})
  for (const result of [
    {status: 1, signal: null, stdout: '', stderr: '[desktop-diagnostic] source_rollback_unavailable\n', readiness: Buffer.alloc(0)},
    {status: 0, signal: null, stdout: 'private', stderr: '[desktop-diagnostic] source_rollback_unavailable\n', readiness: Buffer.alloc(0)},
    {status: 0, signal: null, stdout: '', stderr: '[desktop-diagnostic] source_rollback_unavailable\nprivate', readiness: Buffer.alloc(0)},
    {status: 0, signal: null, stdout: '', stderr: '[desktop-diagnostic] source_rollback_unavailable\n', readiness: Buffer.from('ready')},
  ]) {
    assert.throws(() => classifySourceRollbackResult(result), /installed_source_rollback_failed/u)
  }
})

test('installed launch deletes backend selection and poisons every Python resolution path', () => {
  const environment = smokeEnvironment({
    parentEnvironment: {
      PATH: '/usr/bin',
      NOVA_AUDIO_AGENT_BACKEND: 'python',
      NOVA_AUDIO_AGENT_PYTHON: '/private/python',
      PYTHONPATH: '/private/modules',
      VIRTUAL_ENV: '/private/venv',
      CONDA_PREFIX: '/private/conda',
      HOME: '/private/home',
    },
    poisonPath: '/private/smoke/poison',
    workspace: '/private/smoke/workspace',
    caCertificate: '/private/smoke/public-ca.pem',
    providerEndpoint: 'wss://127.0.0.1:49152/',
    cameraFile: '/private/smoke/camera.mp4',
  })
  assert.equal(environment.PATH, '/private/smoke/poison')
  assert.equal('NOVA_AUDIO_AGENT_BACKEND' in environment, false)
  for (const key of ['NOVA_AUDIO_AGENT_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX']) {
    assert.equal(key in environment, false)
  }
  assert.equal(environment.NOVA_AUDIO_AGENT_RELEASE_SMOKE, RELEASE_SMOKE_MODE)
  assert.equal(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_URL, 'wss://127.0.0.1:49152/')
  assert.equal(environment.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE, '/private/smoke/camera.mp4')
})

test('packaged camera evidence is pass or the exact non-green capability sentinel', () => {
  assert.deepEqual(classifyCameraCapability(0, '{"ok":true}\n'), {status: 'passed'})
  assert.deepEqual(classifyCameraCapability(75, `${CAMERA_CAPABILITY_PENDING}\n`), {
    status: 'pending',
    result_code: 'chromium_codec_unavailable',
  })
  for (const [code, line] of [[0, 'wrong\n'], [75, 'wrong\n'], [1, CAMERA_CAPABILITY_PENDING]]) {
    assert.throws(() => classifyCameraCapability(code, line), /installed_camera_smoke_failed/u)
  }
})

test('release workflow downloads exact candidates into checkout-free smoke jobs', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/release-candidate.yml', import.meta.url), 'utf8')
  assert.match(workflow, /installed-candidate-smoke/u)
  assert.match(workflow, /actions\/download-artifact@v4/u)
  assert.match(workflow, /installed-candidate-smoke\.mjs/u)
  assert.match(workflow, /attest-build-provenance@v3/u)
  assert.match(workflow, /id-token: write/u)
  const smokeStart = workflow.indexOf('  installed-candidate-smoke:')
  const smokeJob = workflow.slice(smokeStart, workflow.indexOf('\n  pending-candidate-ledger:', smokeStart))
  assert.doesNotMatch(smokeJob, /actions\/checkout/u)
  assert.doesNotMatch(smokeJob, /continue-on-error|\|\| true/u)
})
