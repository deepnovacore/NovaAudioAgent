import {spawn} from 'node:child_process'
import {mkdir, mkdtemp, rm} from 'node:fs/promises'
import {resolve} from 'node:path'

import {prepareWindowsSmokeHomeOwnership} from './installed-candidate-smoke.mjs'

export const SOURCE_STARTUP_SMOKE_ARGUMENT = '--nova-source-startup-smoke-v1'
const READY_LINE = '[desktop-smoke] source_window_ready\n'
const MAX_OUTPUT = 16 * 1024

export function sourceStartupSmokeEnvironment(parentEnvironment, {home}) {
  const environment = {}
  for (const [key, value] of Object.entries(parentEnvironment)) {
    const normalizedKey = key.toUpperCase()
    if (
      normalizedKey.startsWith('NOVA_') ||
      normalizedKey === 'ELECTRON_RUN_AS_NODE' ||
      normalizedKey === 'HOME' ||
      normalizedKey === 'USERPROFILE'
    ) continue
    environment[key] = value
  }
  environment.HOME = home
  environment.USERPROFILE = home
  return environment
}

export async function runSourceStartupSmoke({
  packageRoot = resolve(import.meta.dirname, '..'),
  platform = process.platform,
  timeoutMs = 20_000,
} = {}) {
  if (platform !== 'win32') return Object.freeze({status: 'skipped'})
  const userData = await mkdtemp(resolve(packageRoot, 'build', 'source-startup-smoke-'))
  const home = resolve(userData, 'home')
  await mkdir(home, {mode: 0o700})
  prepareWindowsSmokeHomeOwnership({home, environment: process.env})
  const electron = resolve(packageRoot, 'node_modules/electron/dist/electron.exe')
  let child = null
  try {
    child = spawn(electron, [
      packageRoot,
      SOURCE_STARTUP_SMOKE_ARGUMENT,
      `--user-data-dir=${userData}`,
    ], {
      cwd: packageRoot,
      env: sourceStartupSmokeEnvironment(process.env, {home}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT)
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    const result = await new Promise(resolveResult => {
      const timer = setTimeout(() => resolveResult({timedOut: true}), timeoutMs)
      child.once('error', error => {
        clearTimeout(timer)
        resolveResult({error})
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolveResult({code, signal})
      })
    })
    if (result.timedOut) {
      child.kill('SIGKILL')
      await new Promise(resolveExit => child.once('exit', resolveExit))
      throw new Error('source_startup_smoke_timeout')
    }
    if (result.error || result.code !== 0 || !stdout.includes(READY_LINE)) {
      const diagnostic = stderr.match(/\[desktop-diagnostic\] [^\r\n]+/u)?.[0] ?? 'unavailable'
      throw new Error(`source_startup_smoke_failed diagnostic=${diagnostic}`)
    }
    return Object.freeze({status: 'passed'})
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(userData, {recursive: true, force: true}).catch(() => undefined)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const result = await runSourceStartupSmoke()
    process.stdout.write(result.status === 'skipped'
      ? 'source startup smoke skipped\n'
      : 'source startup smoke passed\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
