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
      GH_TOKEN: 'private-gh-token',
      GITHUB_WORKSPACE: '/private/runner/workspace',
      GITHUB_ENV: '/private/runner/github-env',
      RUNNER_TEMP: '/private/runner/temp',
      RUNNER_TOOL_CACHE: '/private/runner/tool-cache',
      SSH_AUTH_SOCK: '/private/runner/ssh-agent',
      NOVA_AUDIO_AGENT_BACKEND: 'python',
      NOVA_AUDIO_AGENT_PYTHON: '/private/python',
      PYTHONPATH: '/private/modules',
      VIRTUAL_ENV: '/private/venv',
      CONDA_PREFIX: '/private/conda',
      HOME: '/private/home',
      TMPDIR: '/private/runner/tmpdir',
      TMP: '/private/runner/tmp',
      TEMP: '/private/runner/temp',
      LANG: 'en_US.UTF-8',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/private/runner/xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/private/runner/dbus',
      XDG_RUNTIME_DIR: '/private/runner/xdg-runtime',
    },
    platform: 'linux',
    poisonPath: '/private/smoke/poison',
    workspace: '/private/smoke/workspace',
    userDataRoot: '/private/smoke/user-data',
    caCertificate: '/private/smoke/public-ca.pem',
    providerEndpoint: 'wss://127.0.0.1:49152/',
    cameraFile: '/private/smoke/camera.mp4',
  })
  assert.equal(environment.PATH, '/private/smoke/poison')
  assert.equal('NOVA_AUDIO_AGENT_BACKEND' in environment, false)
  for (const key of ['NOVA_AUDIO_AGENT_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX']) {
    assert.equal(key in environment, false)
  }
  for (const key of [
    'GH_TOKEN', 'GITHUB_WORKSPACE', 'GITHUB_ENV', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE',
    'SSH_AUTH_SOCK',
  ]) assert.equal(key in environment, false, key)
  assert.equal(environment.LANG, 'en_US.UTF-8')
  assert.equal(environment.DISPLAY, ':99')
  assert.equal(environment.WAYLAND_DISPLAY, 'wayland-0')
  assert.equal(environment.XAUTHORITY, '/private/runner/xauthority')
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/private/runner/dbus')
  assert.equal(environment.XDG_RUNTIME_DIR, '/private/runner/xdg-runtime')
  for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA']) {
    assert.equal(environment[key], '/private/smoke/user-data', key)
  }
  assert.equal(environment.NOVA_AUDIO_AGENT_RELEASE_SMOKE, RELEASE_SMOKE_MODE)
  assert.equal(environment.NOVA_AUDIO_AGENT_QWEN_REALTIME_URL, 'wss://127.0.0.1:49152/')
  assert.equal(environment.NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE, '/private/smoke/camera.mp4')
})

test('installed candidate system children receive only controlled OS and GUI environment', async () => {
  const {candidateBaseEnvironment} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof candidateBaseEnvironment, 'function')
  const environment = candidateBaseEnvironment({
    parentEnvironment: {
      PATH: '/private/runner/tools',
      GH_TOKEN: 'private-gh-token',
      GITHUB_WORKSPACE: '/private/runner/workspace',
      RUNNER_TEMP: '/private/runner/temp',
      LANG: 'C.UTF-8',
      DISPLAY: ':99',
      XAUTHORITY: '/private/runner/xauthority',
    },
    platform: 'linux',
    userDataRoot: '/private/smoke/system-user',
    path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  })
  assert.deepEqual(environment, {
    LANG: 'C.UTF-8',
    DISPLAY: ':99',
    XAUTHORITY: '/private/runner/xauthority',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/private/smoke/system-user',
    XDG_CONFIG_HOME: '/private/smoke/system-user',
    XDG_CACHE_HOME: '/private/smoke/system-user',
    XDG_DATA_HOME: '/private/smoke/system-user',
    APPDATA: '/private/smoke/system-user',
    LOCALAPPDATA: '/private/smoke/system-user',
    TMPDIR: '/private/smoke/system-user',
    TMP: '/private/smoke/system-user',
    TEMP: '/private/smoke/system-user',
  })
})

test('Windows system child environment keeps only paths required for native launch and tree checks', async () => {
  const {candidateBaseEnvironment} = await import('../scripts/installed-candidate-smoke.mjs')
  const environment = candidateBaseEnvironment({
    parentEnvironment: {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemDrive: 'C:',
      PSModulePath: 'C:\\Users\\runneradmin\\Documents\\WindowsPowerShell\\Modules',
      USERPROFILE: 'C:\\Users\\runneradmin',
      GH_TOKEN: 'private-gh-token',
      RUNNER_TEMP: 'C:\\private\\runner-temp',
    },
    platform: 'win32',
    userDataRoot: 'C:\\private\\smoke-user',
    path: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
  })
  assert.equal(environment.SystemRoot, 'C:\\Windows')
  assert.equal(environment.ComSpec, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(
    environment.PSModulePath,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  )
  assert.equal(environment.USERPROFILE, 'C:\\private\\smoke-user')
  assert.equal('GH_TOKEN' in environment, false)
  assert.equal('RUNNER_TEMP' in environment, false)
})

test('packaged camera evidence is pass or the exact non-green capability sentinel', () => {
  assert.deepEqual(classifyCameraCapability({
    status: 0,
    signal: null,
    error: undefined,
    stdout: '{"ok":true}\n',
    stderr: '',
  }), {status: 'passed'})
  assert.deepEqual(classifyCameraCapability({
    status: 75,
    signal: null,
    error: undefined,
    stdout: `${CAMERA_CAPABILITY_PENDING}\n`,
    stderr: '',
  }), {
    status: 'pending',
    result_code: 'chromium_codec_unavailable',
  })
  for (const result of [
    {status: 0, signal: null, stdout: 'wrong\n', stderr: ''},
    {status: 75, signal: null, stdout: 'wrong\n', stderr: ''},
    {status: 1, signal: null, stdout: CAMERA_CAPABILITY_PENDING, stderr: ''},
    {status: 75, signal: null, stdout: `${CAMERA_CAPABILITY_PENDING}\n`, stderr: 'private'},
    {status: 0, signal: 'SIGTERM', stdout: '{"ok":true}\n', stderr: ''},
    {status: 0, signal: null, error: new Error('private'), stdout: '{"ok":true}\n', stderr: ''},
  ]) {
    assert.throws(() => classifyCameraCapability(result), /installed_camera_smoke_failed/u)
  }
})

test('installed candidate signer workflow authority is closed to the two release workflows', async () => {
  const {canonicalSignerWorkflow} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof canonicalSignerWorkflow, 'function')
  assert.equal(
    canonicalSignerWorkflow('deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml'),
    'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
  )
  assert.equal(
    canonicalSignerWorkflow('deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml'),
    'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
  )
  assert.throws(
    () => canonicalSignerWorkflow('owner/repo/.github/workflows/arbitrary.yml'),
    /installed_candidate_attestation_failed/u,
  )
})

test('installed candidate CLI defaults release authority and accepts only explicit unsigned authority', async () => {
  const {cliOptions} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof cliOptions, 'function')
  const required = [
    '--target', 'linux-x64-gnu:appimage',
    '--artifact', '/candidate/nova-linux-x64.AppImage',
    '--sha256', 'a'.repeat(64),
    '--commit', 'b'.repeat(40),
  ]
  assert.equal(
    cliOptions(required).get('--signer-workflow'),
    'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
  )
  assert.equal(
    cliOptions([
      ...required,
      '--signer-workflow', 'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
    ]).get('--signer-workflow'),
    'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
  )
  assert.throws(
    () => cliOptions([...required, '--signer-workflow', 'owner/repo/.github/workflows/arbitrary.yml']),
    /installed_candidate_attestation_failed/u,
  )
})

test('unsigned installed smoke wrapper accepts only complete pass or exact camera pending evidence', async () => {
  const {classifyUnsignedSmoke} = await import('../scripts/run-unsigned-installed-smoke.mjs')
  assert.deepEqual(classifyUnsignedSmoke({
    status: 0,
    signal: null,
    stdout: 'installed candidate smoke passed\n',
    stderr: '',
  }), {installed: 'passed', camera: 'passed'})
  assert.deepEqual(classifyUnsignedSmoke({
    status: 75,
    signal: null,
    stdout: 'camera-file-integration: chromium_codec_unavailable\n',
    stderr: '',
  }), {installed: 'passed', camera: 'pending'})
  for (const result of [
    {status: 1, signal: null, stdout: '', stderr: 'private'},
    {status: 75, signal: null, stdout: 'wrong\n', stderr: ''},
    {status: 75, signal: null, stdout: 'camera-file-integration: chromium_codec_unavailable\n', stderr: 'private'},
    {status: 0, signal: 'SIGTERM', stdout: 'installed candidate smoke passed\n', stderr: ''},
  ]) {
    assert.throws(() => classifyUnsignedSmoke(result), /unsigned_installed_smoke_failed/u)
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
