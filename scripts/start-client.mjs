#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, posix, resolve, win32 } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import { codexCandidates } from '../desktop/ambient-orb/src/main/codex-discovery.mjs'

const DESKTOP_WORKSPACE = '@nova-audio-agent/ambient-orb'
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

export function parseClientEnvironment({contents, shellEnv}) {
  return {...parseEnv(contents), ...shellEnv}
}

export function assertNativeToolchain({platform, env, pathExists, runVswhere}) {
  if (platform === 'darwin') {
    if (pathExists('/usr/bin/clang') && pathExists('/usr/bin/swiftc')) return
    throw new Error('native toolchain unavailable: install Xcode Command Line Tools')
  }
  if (platform === 'linux') {
    if (pathExists('/usr/bin/cc')) return
    throw new Error('native toolchain unavailable: install a C compiler at /usr/bin/cc')
  }
  if (platform === 'win32') {
    if (env.INCLUDE && env.LIB && env.PATH) return
    const programFiles = env['ProgramFiles(x86)']
    const vswhere = typeof programFiles === 'string'
      ? win32.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
      : null
    if (vswhere !== null && pathExists(vswhere) && typeof runVswhere === 'function') {
      const located = runVswhere(vswhere)
      const installation = typeof located.stdout === 'string'
        ? located.stdout.replace(/[\r\n]+$/u, '')
        : ''
      const vcvars = win32.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
      if (located.status === 0 && installation.length > 0 && pathExists(vcvars)) return
    }
    throw new Error(
      'native toolchain unavailable: install Visual Studio Build Tools with Desktop development with C++',
    )
  }
}

export function electronExecutablePath(rootDir, platform) {
  const pathApi = platform === 'win32' ? win32 : posix
  const distribution = pathApi.join(
    rootDir,
    'desktop',
    'ambient-orb',
    'node_modules',
    'electron',
    'dist',
  )
  if (platform === 'darwin') {
    return pathApi.join(distribution, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return pathApi.join(distribution, platform === 'win32' ? 'electron.exe' : 'electron')
}

function canonicalClientExecutable(candidate, platform) {
  try {
    const canonical = realpathSync(candidate)
    if (!statSync(canonical).isFile()) return null
    if (platform !== 'win32') accessSync(canonical, constants.X_OK)
    const lower = canonical.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) return null
    return canonical
  } catch {
    return null
  }
}

export function resolveClientCodexBinary({
  configured,
  platform,
  arch = process.arch,
  home,
  environment = {},
  pathValue,
  canonicalize = candidate => canonicalClientExecutable(candidate, platform),
}) {
  const pathApi = platform === 'win32' ? win32 : posix
  const requested = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : 'codex'
  const effectiveHome = home
    || environment.USERPROFILE
    || environment.HOME
    || (platform === 'win32' ? 'C:\\' : '/')
  const candidates = pathApi.isAbsolute(requested)
    ? [{ path: requested, source: 'manual' }]
    : requested === 'codex'
      ? codexCandidates({
        platform,
        arch,
        env: { ...environment, PATH: pathValue ?? environment.PATH },
        home: effectiveHome,
        pathApi,
      })
      : []
  for (const candidate of candidates) {
    if (candidate.kind !== 'native') continue
    const canonical = canonicalize(candidate.command)
    if (typeof canonical === 'string' && pathApi.isAbsolute(canonical)) return canonical
  }
  return null
}

export function planClientLaunch({
  argv,
  env,
  envFileContents = '',
  platform,
  rootDir,
  nodeExecutable,
  npmCli,
  codexBinary,
  envFileExists,
  dependenciesInstalled,
}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error('this launcher does not accept arguments')
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error('the Ambient Orb client requires macOS, Linux, or Windows')
  }
  const pathApi = platform === 'win32' ? win32 : posix
  if (typeof npmCli !== 'string' || !pathApi.isAbsolute(npmCli)) {
    throw new Error('npm CLI unavailable; start this command with npm run start:client')
  }
  const hasCodexBinary = typeof codexBinary === 'string' && pathApi.isAbsolute(codexBinary)

  const npm = args => ({command: nodeExecutable, args: [npmCli, ...args]})
  const configuredEnv = parseClientEnvironment({contents: envFileContents, shellEnv: env})
  const clientEnv = {
    ...configuredEnv,
    NOVA_AUDIO_AGENT_BACKEND: 'node',
    NOVA_AUDIO_AGENT_CODEX_WORKSPACE:
      configuredEnv.NOVA_AUDIO_AGENT_CODEX_WORKSPACE || rootDir,
    ...(hasCodexBinary ? { NOVA_AUDIO_AGENT_CODEX_BIN: codexBinary } : {}),
    ...(envFileExists ? { NOVA_AUDIO_AGENT_ENV_FILE: pathApi.join(rootDir, '.env') } : {}),
  }
  const steps = []
  if (!dependenciesInstalled) {
    steps.push({...npm(['ci']), cwd: rootDir, env})
    steps.push({
      command: nodeExecutable,
      args: [pathApi.join(
        rootDir,
        'desktop',
        'ambient-orb',
        'node_modules',
        'electron',
        'install.js',
      )],
      cwd: rootDir,
      env,
    })
  }
  steps.push({...npm(['run', 'build']), cwd: rootDir, env})
  steps.push({
    ...npm(['run', 'start:built', '--workspace', DESKTOP_WORKSPACE]),
    cwd: rootDir,
    env: clientEnv,
  })
  return Object.freeze(steps.map(step => Object.freeze(step)))
}

function runStep(step) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    })
    child.once('error', rejectStep)
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        rejectStep(new Error(`${step.command} stopped by ${signal}`))
      } else if (code !== 0) {
        rejectStep(new Error(`${step.command} exited with ${String(code)}`))
      } else {
        resolveStep()
      }
    })
  })
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix
  const envFile = pathApi.join(rootDir, '.env')
  const envFileExists = existsSync(envFile)
  const envFileContents = envFileExists ? readFileSync(envFile, 'utf8') : ''
  const configuredEnv = parseClientEnvironment({contents: envFileContents, shellEnv: env})
  assertNativeToolchain({
    platform,
    env,
    pathExists: existsSync,
    runVswhere: command => spawnSync(command, [
      '-latest',
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    }),
  })
  const plan = planClientLaunch({
    argv,
    env,
    envFileContents,
    platform,
    rootDir,
    nodeExecutable: process.execPath,
    npmCli: env.npm_execpath,
    codexBinary: resolveClientCodexBinary({
      configured: configuredEnv.NOVA_AUDIO_AGENT_CODEX_BIN,
      platform,
      arch: process.arch,
      home: homedir(),
      environment: configuredEnv,
      pathValue: configuredEnv.PATH,
    }),
    envFileExists,
    dependenciesInstalled: existsSync(electronExecutablePath(rootDir, platform)),
  })
  for (const step of plan) await runStep(step)
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : 'client launch failed'
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  })
}
