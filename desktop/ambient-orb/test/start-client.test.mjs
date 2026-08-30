import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import {
  assertNativeToolchain,
  electronExecutablePath,
  parseClientEnvironment,
  planClientLaunch,
  resolveClientCodexBinary,
} from '../../../scripts/start-client.mjs'

const DEMO_LAUNCHER_URL = new URL('../../../scripts/start-client-demo.mjs', import.meta.url)

test('root demo command selects the repository camera fixture without mutating its environment', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../../../package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(manifest.scripts['start:client_demo'], 'node scripts/start-client-demo.mjs')

  let demoLauncher
  await assert.doesNotReject(async () => {
    demoLauncher = await import(DEMO_LAUNCHER_URL)
  })

  const environment = { KEEP_ME: 'yes' }
  assert.deepEqual(demoLauncher.demoClientEnvironment({
    environment,
    rootDir: '/repo',
    pathApi: posix,
  }), {
    KEEP_ME: 'yes',
    NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE:
      '/repo/assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
  })
  assert.deepEqual(environment, { KEEP_ME: 'yes' })

  assert.equal(demoLauncher.demoClientEnvironment({
    environment: {},
    rootDir: 'C:\\repo',
    pathApi: win32,
  }).NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE,
  'C:\\repo\\assets\\demos\\cat-sofa-guard\\cat-sofa-guard.mp4')
})

test('native toolchain preflight reports stable platform-specific setup guidance', () => {
  assert.throws(() => assertNativeToolchain({
    platform: 'darwin',
    env: {},
    pathExists: path => path !== '/usr/bin/swiftc',
  }), /native toolchain unavailable: install Xcode Command Line Tools/u)

  assert.throws(() => assertNativeToolchain({
    platform: 'linux',
    env: {},
    pathExists: () => false,
  }), /native toolchain unavailable: install a C compiler at \/usr\/bin\/cc/u)

  assert.throws(() => assertNativeToolchain({
    platform: 'win32',
    env: {'ProgramFiles(x86)': 'C:\\Program Files (x86)'},
    pathExists: () => true,
    runVswhere: () => ({status: null, stdout: null}),
  }), /native toolchain unavailable: install Visual Studio Build Tools with Desktop development with C\+\+/u)

  assert.throws(() => assertNativeToolchain({
    platform: 'win32',
    env: {'ProgramFiles(x86)': 'C:\\Program Files (x86)'},
    pathExists: path => !path.endsWith('vcvars64.bat'),
    runVswhere: () => ({status: 0, stdout: 'C:\\Visual Studio\r\n'}),
  }), /native toolchain unavailable: install Visual Studio Build Tools with Desktop development with C\+\+/u)

  assert.doesNotThrow(() => assertNativeToolchain({
    platform: 'darwin',
    env: {},
    pathExists: () => true,
  }))
  assert.doesNotThrow(() => assertNativeToolchain({
    platform: 'linux',
    env: {},
    pathExists: () => true,
  }))
  assert.doesNotThrow(() => assertNativeToolchain({
    platform: 'win32',
    env: {INCLUDE: 'set', LIB: 'set', PATH: 'set'},
    pathExists: () => false,
  }))
  assert.doesNotThrow(() => assertNativeToolchain({
    platform: 'win32',
    env: {'ProgramFiles(x86)': 'C:\\Program Files (x86)'},
    pathExists: () => true,
    runVswhere: () => ({status: 0, stdout: 'C:\\Visual Studio\r\n'}),
  }))
})

test('client environment loads literal dotenv values while the invoking shell wins', () => {
  const environment = parseClientEnvironment({
    contents: [
      'DASHSCOPE_API_KEY=from-file',
      'TAVILY_API_KEY="file value"',
      'LITERAL=$(touch /tmp/must-not-run)',
      '',
    ].join('\n'),
    shellEnv: {
      DASHSCOPE_API_KEY: 'from-shell',
      KEEP_ME: 'yes',
    },
  })

  assert.deepEqual(environment, {
    DASHSCOPE_API_KEY: 'from-shell',
    TAVILY_API_KEY: 'file value',
    LITERAL: '$(touch /tmp/must-not-run)',
    KEEP_ME: 'yes',
  })
})

test('dependency readiness is based on the real Electron executable, not its package manifest', () => {
  assert.equal(
    electronExecutablePath('/repo', 'darwin'),
    '/repo/desktop/ambient-orb/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  )
  assert.equal(
    electronExecutablePath('C:\\repo', 'win32'),
    'C:\\repo\\desktop\\ambient-orb\\node_modules\\electron\\dist\\electron.exe',
  )
  assert.equal(
    electronExecutablePath('/repo', 'linux'),
    '/repo/desktop/ambient-orb/node_modules/electron/dist/electron',
  )
})

test('client resolves the canonical Codex executable without invoking a shell', () => {
  const attempted = []
  assert.equal(resolveClientCodexBinary({
    configured: 'codex',
    platform: 'darwin',
    pathValue: '/first:/second',
    canonicalize: candidate => {
      attempted.push(candidate)
      return candidate === '/second/codex' ? '/canonical/codex' : null
    },
  }), '/canonical/codex')
  assert.deepEqual(attempted, ['/first/codex', '/second/codex'])
  assert.equal(resolveClientCodexBinary({
    configured: 'relative-custom-codex',
    platform: 'linux',
    pathValue: '/bin',
    canonicalize: () => null,
  }), null)
})

test('client resolves an npm Windows shim directory to its native Codex binary', () => {
  const native = 'C:\\Users\\nova\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'
  const attempted = []

  assert.equal(resolveClientCodexBinary({
    configured: 'codex',
    platform: 'win32',
    arch: 'x64',
    home: 'C:\\Users\\nova',
    environment: { APPDATA: 'C:\\Users\\nova\\AppData\\Roaming' },
    pathValue: 'C:\\Users\\nova\\AppData\\Roaming\\npm',
    canonicalize: candidate => {
      attempted.push(candidate)
      return candidate === native ? native : null
    },
  }), native)
  assert.ok(attempted.includes(native))
  assert.equal(attempted.some(candidate => candidate.endsWith('codex.cmd')), false)
})

test('client launch plan installs when needed, builds once, and forces the Node desktop backend', () => {
  const plan = planClientLaunch({
    argv: [],
    env: {KEEP_ME: 'yes'},
    envFileContents: [
      'TAVILY_API_KEY=from-file',
      'KEEP_ME=from-file',
      'NOVA_AUDIO_AGENT_CODEX_WORKSPACE=~/configured/workspace',
      'NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT=~/.nova-audio-agent/workspaces',
      'NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT=~/.nova-audio-agent',
      '',
    ].join('\n'),
    platform: 'darwin',
    homeDirectory: '/Users/example',
    rootDir: '/repo',
    nodeExecutable: '/opt/node',
    npmCli: '/opt/npm/bin/npm-cli.js',
    codexBinary: '/opt/codex/bin/codex',
    envFileExists: true,
    dependenciesInstalled: false,
  })

  assert.deepEqual(plan.map(step => ({command: step.command, args: step.args})), [
    {command: '/opt/node', args: ['/opt/npm/bin/npm-cli.js', 'ci']},
    {
      command: '/opt/node',
      args: ['/repo/desktop/ambient-orb/node_modules/electron/install.js'],
    },
    {command: '/opt/node', args: ['/opt/npm/bin/npm-cli.js', 'run', 'build']},
    {
      command: '/opt/node',
      args: [
        '/opt/npm/bin/npm-cli.js',
        'run',
        'start:built',
        '--workspace',
        '@nova-audio-agent/ambient-orb',
      ],
    },
  ])
  assert.equal(plan[3].env.KEEP_ME, 'yes')
  assert.equal(plan[3].env.TAVILY_API_KEY, 'from-file')
  assert.equal(plan[3].env.NOVA_AUDIO_AGENT_BACKEND, 'node')
  assert.equal(plan[3].env.NOVA_AUDIO_AGENT_CODEX_BIN, '/opt/codex/bin/codex')
  assert.equal(plan[3].env.NOVA_AUDIO_AGENT_CODEX_WORKSPACE, '/Users/example/configured/workspace')
  assert.equal(
    plan[3].env.NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT,
    '/Users/example/.nova-audio-agent/workspaces',
  )
  assert.equal(
    plan[3].env.NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT,
    '/Users/example/.nova-audio-agent',
  )
  assert.equal(plan[3].env.NOVA_AUDIO_AGENT_ENV_FILE, '/repo/.env')
})

test('client launch plan is Windows-safe and skips an unnecessary install', () => {
  const plan = planClientLaunch({
    argv: [],
    env: {},
    platform: 'win32',
    rootDir: 'C:\\repo',
    nodeExecutable: 'C:\\Node\\node.exe',
    npmCli: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
    codexBinary: 'C:\\Tools\\codex.exe',
    envFileExists: true,
    dependenciesInstalled: true,
  })

  assert.deepEqual(plan.map(step => ({command: step.command, args: step.args})), [
    {
      command: 'C:\\Node\\node.exe',
      args: [
        'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
        'run',
        'build',
      ],
    },
    {
      command: 'C:\\Node\\node.exe',
      args: [
        'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
        'run',
        'start:built',
        '--workspace',
        '@nova-audio-agent/ambient-orb',
      ],
    },
  ])
})

test('client launch plan starts the settings-capable desktop without env or Codex', () => {
  const plan = planClientLaunch({
    argv: [],
    env: { KEEP_ME: 'yes' },
    platform: 'win32',
    rootDir: 'C:\\repo',
    nodeExecutable: 'C:\\Node\\node.exe',
    npmCli: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
    codexBinary: null,
    envFileExists: false,
    dependenciesInstalled: true,
  })

  assert.equal(plan.length, 2)
  assert.equal(plan[1].env.KEEP_ME, 'yes')
  assert.equal(plan[1].env.NOVA_AUDIO_AGENT_BACKEND, 'node')
  assert.equal('NOVA_AUDIO_AGENT_CODEX_BIN' in plan[1].env, false)
  assert.equal('NOVA_AUDIO_AGENT_ENV_FILE' in plan[1].env, false)
})

test('client launch plan fails before side effects for an invalid invocation', () => {
  assert.throws(() => planClientLaunch({
    argv: ['unexpected'],
    env: {},
    platform: 'linux',
    rootDir: '/repo',
    envFileExists: true,
    dependenciesInstalled: true,
  }), /does not accept arguments/u)

  assert.throws(() => planClientLaunch({
    argv: [],
    env: {},
    platform: 'win32',
    rootDir: 'C:\\repo',
    nodeExecutable: 'C:\\Node\\node.exe',
    npmCli: 'npm-cli.js',
    envFileExists: true,
    dependenciesInstalled: true,
  }), /npm CLI unavailable/u)
})
