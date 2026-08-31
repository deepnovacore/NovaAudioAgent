import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import test from 'node:test'

import {
  CAMERA_CAPABILITY_PASSED_EXIT_CODE,
  CAMERA_CAPABILITY_PENDING_EXIT_CODE,
  NATIVE_INSTALLER_SETTLE_MS,
  RELEASE_SMOKE_MODE,
  SCRATCH_REMOVAL_OPTIONS,
  SOURCE_ROLLBACK_UNAVAILABLE_EXIT_CODE,
  candidateInstallPlan,
  classifyCameraCapability,
  smokeEnvironment,
} from '../scripts/installed-candidate-smoke.mjs'

const processTreeFixture = resolve(import.meta.dirname, 'fixtures/windows-guardian-target.cjs')

test('installed scratch cleanup retries transient Windows file locks', () => {
  assert.deepEqual(SCRATCH_REMOVAL_OPTIONS, {
    recursive: true,
    force: true,
    maxRetries: 100,
    retryDelay: 50,
  })
  assert.equal(Object.isFrozen(SCRATCH_REMOVAL_OPTIONS), true)
})

function spawnSmokeFixture(mode) {
  const environment = {...process.env}
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_TEST_WORKER_ID
  return spawn(process.execPath, [processTreeFixture, mode], {
    detached: process.platform !== 'win32',
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  })
}

function readFixtureGrandchild(child) {
  return new Promise((resolvePid, rejectPid) => {
    let output = ''
    const timer = setTimeout(() => rejectPid(new Error('fixture grandchild timeout')), 5_000)
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      const match = /^grandchild:([0-9]+)\n/u.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolvePid(Number.parseInt(match[1], 10))
    })
    child.once('error', error => {
      clearTimeout(timer)
      rejectPid(error)
    })
  })
}

function assertPidGone(pid) {
  assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH')
}

test('installed candidate plans use native install or mount boundaries for every closed artifact', () => {
  const root = '/private/smoke'
  const matrix = [
    ['darwin-arm64:app', 'nova-audio-agent-0.1.0-macos-arm64-app.zip', '/private/smoke/install/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/install'],
    ['darwin-arm64:dmg', 'nova-audio-agent-0.1.0-macos-arm64.dmg', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb'],
    ['darwin-x64:app', 'nova-audio-agent-0.1.0-macos-x64-app.zip', '/private/smoke/install/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/install'],
    ['darwin-x64:dmg', 'nova-audio-agent-0.1.0-macos-x64.dmg', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb', '/private/smoke/mount/Nova Audio Agent Ambient Orb.app/Contents/MacOS/Nova Audio Agent Ambient Orb'],
    ['win32-x64:nsis', 'nova-audio-agent-0.1.0-windows-x64.exe', '/private/smoke/install/Nova Audio Agent Ambient Orb.exe', '/private/smoke/install'],
    ['linux-x64-gnu:appimage', 'nova-audio-agent-0.1.0-linux-x64.AppImage', '/private/smoke/install/squashfs-root/AppRun', '/private/smoke/install'],
    ['linux-x64-gnu:deb', 'nova-audio-agent-0.1.0-linux-x64.deb', '/usr/bin/nova-ambient-orb', '/usr/bin/nova-ambient-orb'],
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

test('Windows native installer actions allow enough time for cold CI extraction', () => {
  const plan = candidateInstallPlan({
    target: 'win32-x64:nsis',
    artifact: '/private/candidate/nova-audio-agent-0.1.0-windows-x64.exe',
    scratch: '/private/scratch',
  })
  assert.equal(NATIVE_INSTALLER_SETTLE_MS, 120_000)
  assert.equal(plan.install[0].timeoutMs, NATIVE_INSTALLER_SETTLE_MS)
  assert.equal(plan.uninstall[0].timeoutMs, NATIVE_INSTALLER_SETTLE_MS)
})

test('Windows NSIS actions preserve spaced install roots and bind the uninstaller directory', () => {
  const plan = candidateInstallPlan({
    target: 'win32-x64:nsis',
    artifact: '/private/Candidate Files/nova setup.exe',
    scratch: '/private/Smoke Root',
  })
  assert.deepEqual(plan.install[0].args, ['/S', '/D=/private/Smoke Root/install'])
  assert.equal(plan.install[0].windowsVerbatimArguments, true)
  assert.deepEqual(plan.uninstall[0].args, ['/S', '_?=/private/Smoke Root/install'])
  assert.equal(plan.uninstall[0].windowsVerbatimArguments, true)
})

test('installed source rollback accepts its stable exit code despite platform output', async () => {
  const {classifySourceRollbackResult} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.deepEqual(classifySourceRollbackResult({
    status: SOURCE_ROLLBACK_UNAVAILABLE_EXIT_CODE,
    signal: null,
    error: undefined,
    stdout: '[electron] platform diagnostic\r\n',
    stderr: '[electron] platform diagnostic\r\n',
  }), {status: 'passed'})
  for (const result of [
    {status: 0, signal: null, stdout: '', stderr: ''},
    {status: 1, signal: null, stdout: '', stderr: ''},
    {status: SOURCE_ROLLBACK_UNAVAILABLE_EXIT_CODE, signal: 'SIGTERM', stdout: '', stderr: ''},
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
  assert.equal(environment.TAVILY_API_KEY, 'public-release-smoke-key')
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
    status: CAMERA_CAPABILITY_PASSED_EXIT_CODE,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '[electron] platform diagnostic\r\n',
  }), {status: 'passed'})
  assert.deepEqual(classifyCameraCapability({
    status: CAMERA_CAPABILITY_PENDING_EXIT_CODE,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '',
  }), {
    status: 'pending',
    result_code: 'chromium_codec_unavailable',
  })
  for (const result of [
    {status: 0, signal: null, stdout: '', stderr: ''},
    {status: 1, signal: null, stdout: '', stderr: ''},
    {status: CAMERA_CAPABILITY_PASSED_EXIT_CODE, signal: 'SIGTERM', stdout: '', stderr: ''},
    {status: CAMERA_CAPABILITY_PASSED_EXIT_CODE, signal: null, error: new Error('private'), stdout: '', stderr: ''},
  ]) {
    assert.throws(() => classifyCameraCapability(result), /installed_camera_smoke_failed/u)
  }
})

test('attested candidate signer authority is closed to the formal release workflow', async () => {
  const {canonicalSignerWorkflow} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof canonicalSignerWorkflow, 'function')
  assert.equal(
    canonicalSignerWorkflow('deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml'),
    'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
  )
  for (const workflow of [
    'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
    'owner/repo/.github/workflows/arbitrary.yml',
  ]) assert.throws(() => canonicalSignerWorkflow(workflow), /installed_candidate_attestation_failed/u)
})

test('installed candidate CLI defaults to and permits only formal release authority', async () => {
  const {cliOptions} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof cliOptions, 'function')
  const required = [
    '--target', 'linux-x64-gnu:appimage',
    '--artifact', '/candidate/nova-audio-agent-0.1.0-linux-x64.AppImage',
    '--sha256', 'a'.repeat(64),
    '--commit', 'b'.repeat(40),
  ]
  assert.equal(
    cliOptions(required).get('--signer-workflow'),
    'deepnovacore/NovaAudioAgent/.github/workflows/release-candidate.yml',
  )
  for (const workflow of [
    'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml',
    'owner/repo/.github/workflows/arbitrary.yml',
  ]) {
    assert.throws(
      () => cliOptions([...required, '--signer-workflow', workflow]),
      /installed_candidate_attestation_failed/u,
    )
  }
})

test('same-workflow unsigned artifact CLI is digest-bound and refuses attestation claims', async () => {
  const {workflowArtifactCliOptions} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.equal(typeof workflowArtifactCliOptions, 'function')
  const required = [
    '--target', 'win32-x64:nsis',
    '--artifact', 'C:\\candidate\\nova-audio-agent-0.1.0-windows-x64.exe',
    '--sha256', 'a'.repeat(64),
  ]
  const values = workflowArtifactCliOptions(required)
  assert.equal(values.get('--target'), 'win32-x64:nsis')
  assert.equal(values.get('--sha256'), 'a'.repeat(64))
  for (const forbidden of [
    ['--commit', 'b'.repeat(40)],
    ['--signer-workflow', 'deepnovacore/NovaAudioAgent/.github/workflows/unsigned-packages.yml'],
  ]) {
    assert.throws(
      () => workflowArtifactCliOptions([...required, ...forbidden]),
      /installed_candidate_usage_failed/u,
    )
  }
})

test('unsigned installed smoke wrapper accepts only complete in-process camera evidence', async () => {
  const {classifyUnsignedCamera} = await import('../scripts/run-unsigned-installed-smoke.mjs')
  assert.deepEqual(classifyUnsignedCamera(null), {installed: 'passed', camera: 'passed'})
  assert.deepEqual(classifyUnsignedCamera({status: 'passed'}), {
    installed: 'passed',
    camera: 'passed',
  })
  assert.deepEqual(classifyUnsignedCamera({
    status: 'pending',
    result_code: 'chromium_codec_unavailable',
  }), {installed: 'passed', camera: 'pending'})
  for (const result of [
    {status: 'pending', result_code: 'wrong'},
    {status: 'failed'},
    undefined,
  ]) {
    assert.throws(() => classifyUnsignedCamera(result), /unsigned_installed_smoke_failed/u)
  }
})

test('managed installed-candidate cleanup kills and proves the complete descendant tree gone', async () => {
  const {withCandidateProcessTree} = await import('../scripts/installed-candidate-smoke.mjs')
  const child = spawnSmokeFixture('smoke-tree')
  const grandchildPid = await readFixtureGrandchild(child)
  await assert.rejects(
    withCandidateProcessTree(child, process.env, () => {
      throw new Error('synchronous exercise failure')
    }),
    /synchronous exercise failure/u,
  )
  assert.notEqual(child.pid, undefined)
  assertPidGone(child.pid)
  assertPidGone(grandchildPid)
})

test('managed installed-candidate cleanup runs after an asynchronous timeout rejection', async () => {
  const {withCandidateProcessTree} = await import('../scripts/installed-candidate-smoke.mjs')
  const child = spawnSmokeFixture('smoke-tree')
  await readFixtureGrandchild(child)
  await assert.rejects(
    withCandidateProcessTree(child, process.env, async () => {
      await new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => rejectWait(new Error('exercise timeout')), 30)
        timer.unref()
      })
    }),
    /exercise timeout/u,
  )
})

test('installed-candidate output overflow rejects immediately instead of waiting for readiness', async () => {
  const {exerciseCandidateChild, withCandidateProcessTree} = await import(
    '../scripts/installed-candidate-smoke.mjs'
  )
  const child = spawnSmokeFixture('smoke-output-flood')
  const startedAt = Date.now()
  await assert.rejects(
    withCandidateProcessTree(child, process.env, () => exerciseCandidateChild(child)),
    /installed_candidate_output_failed/u,
  )
  assert.ok(Date.now() - startedAt < 5_000, 'output overflow must beat the readiness timeout')
})

test('installed-candidate output drain is bounded when an orphan retains the pipes', async () => {
  const {settleCandidateOutput} = await import('../scripts/installed-candidate-smoke.mjs')
  const never = new Promise(() => {})
  const startedAt = Date.now()
  await assert.rejects(
    settleCandidateOutput({done: never, failure: never}, 25),
    /installed_candidate_output_failed/u,
  )
  assert.ok(Date.now() - startedAt < 1_000, 'orphan-held output must not prevent tree cleanup')
})

test('installed-candidate diagnostics expose only stable failure and child codes', async () => {
  const {
    installedSmokeDiagnostic,
    sourceRollbackResultDiagnostic,
  } = await import('../scripts/installed-candidate-smoke.mjs')
  const operation = new Error('installed_candidate_readiness_failed')
  const cleanup = new Error('private path C:\\Users\\runneradmin\\secret')
  const failure = new Error('installed_candidate_tree_failed', {
    cause: new AggregateError([operation, cleanup]),
  })
  assert.equal(installedSmokeDiagnostic(failure, {
    stderr: [
      '[backend-diagnostic] [runtime-diagnostic] assembly_failed',
      'private path C:\\Users\\runneradmin\\secret',
      '[desktop-diagnostic] startup_failure code=project_directory_open_failed_home',
      '[desktop-diagnostic] source_rollback_unavailable',
    ].join('\n'),
    exitCode: null,
    signalCode: null,
  }), 'failure=installed_candidate_tree_failed+installed_candidate_readiness_failed '
    + 'child=assembly_failed+source_rollback_unavailable'
    + '+startup_project_directory_open_failed_home state=running')
  assert.equal(installedSmokeDiagnostic(cleanup, {
    stderr: 'token=private-secret',
    exitCode: 7,
    signalCode: null,
  }), 'failure=unknown child=none state=exit_7')
  assert.equal(sourceRollbackResultDiagnostic({
    status: 0,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '[desktop-diagnostic] source_rollback_unavailable\r\nprivate path',
  }), 'source_rollback_result_status_0_error_none_signal_none_stdout_empty_stderr_expected')
  assert.equal(sourceRollbackResultDiagnostic({
    status: null,
    signal: null,
    error: new Error('private path'),
    stdout: 'private output',
    stderr: 'private error',
  }), 'source_rollback_result_status_none_error_set_signal_none_stdout_set_stderr_other')
})

test('failed candidate cleanup releases every parent-side child handle', async () => {
  const {releaseCandidateChildHandles} = await import('../scripts/installed-candidate-smoke.mjs')
  const calls = []
  const streams = Array.from({length: 5}, (_, index) => ({
    destroy: () => calls.push(`destroy:${index}`),
    unref: () => calls.push(`unref:${index}`),
  }))
  releaseCandidateChildHandles({
    stdio: streams,
    unref: () => calls.push('child:unref'),
  })
  assert.deepEqual(calls, [
    'destroy:0', 'unref:0', 'destroy:1', 'unref:1', 'destroy:2', 'unref:2',
    'destroy:3', 'unref:3', 'destroy:4', 'unref:4', 'child:unref',
  ])
})

test('Windows cleanup uses the bounded native tree terminator without CIM discovery', async () => {
  const {windowsTreeTermination} = await import('../scripts/installed-candidate-smoke.mjs')
  assert.deepEqual(windowsTreeTermination(49152, {SystemRoot: 'C:\\Windows'}), {
    command: 'C:\\Windows\\System32\\taskkill.exe',
    args: ['/PID', '49152', '/T', '/F'],
  })
  assert.throws(() => windowsTreeTermination(0, {SystemRoot: 'C:\\Windows'}),
    /installed_candidate_tree_failed/u)
})

test('provider close does not wait for the WebSocket close callback after clients terminate', async () => {
  const {closeQwenSmokeProvider} = await import('../scripts/installed-candidate-smoke.mjs')
  let terminated = 0
  let socketCloseStarted = 0
  let connectionsClosed = 0
  await closeQwenSmokeProvider({
    sockets: {
      clients: new Set([{terminate: () => { terminated += 1 }}]),
      close: () => { socketCloseStarted += 1 },
    },
    server: {
      close: callback => queueMicrotask(() => callback()),
      closeAllConnections: () => { connectionsClosed += 1 },
      closeIdleConnections: () => {},
      unref: () => {},
    },
  }, 50)
  assert.equal(terminated, 1)
  assert.equal(socketCloseStarted, 1)
  assert.equal(connectionsClosed, 1)
})

test('provider close is bounded and force-unrefs a server whose close callback never arrives', async () => {
  const {closeQwenSmokeProvider} = await import('../scripts/installed-candidate-smoke.mjs')
  let unref = 0
  const startedAt = Date.now()
  await assert.rejects(closeQwenSmokeProvider({
    sockets: {clients: new Set(), close: () => {}},
    server: {
      close: () => {},
      closeAllConnections: () => {},
      closeIdleConnections: () => {},
      unref: () => { unref += 1 },
    },
  }, 25), /installed_candidate_provider_failed/u)
  assert.ok(Date.now() - startedAt < 1_000)
  assert.equal(unref, 1)
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
