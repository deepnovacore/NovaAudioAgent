import {spawnSync} from 'node:child_process'
import {homedir, tmpdir} from 'node:os'
import {posix, win32} from 'node:path'

const OUTPUT_LIMIT = 64 * 1024

export function candidateScratchParent({
  platform = process.platform,
  home = homedir(),
  temporary = tmpdir(),
} = {}) {
  const parent = platform === 'win32' ? home : temporary
  const pathApi = platform === 'win32' ? win32 : posix
  if (typeof parent !== 'string' || !pathApi.isAbsolute(parent)) {
    throw new Error('installed_candidate_invalid')
  }
  return pathApi.resolve(parent)
}

export function prepareWindowsSmokeHomeOwnership({
  platform = process.platform,
  home,
  environment,
  run = spawnSync,
}) {
  if (platform !== 'win32') return
  const systemRoot = environment?.SystemRoot ?? environment?.WINDIR
  if (typeof home !== 'string' || !win32.isAbsolute(home)
    || typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    throw new Error('installed_candidate_invalid')
  }
  const options = {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  const identity = run(win32.join(systemRoot, 'System32', 'whoami.exe'), [
    '/user', '/fo', 'csv', '/nh',
  ], options)
  const match = typeof identity?.stdout === 'string'
    ? /^"[^"\r\n]{1,256}","(S-1-(?:[0-9]+-){1,15}[0-9]+)"\r?\n?$/u.exec(identity.stdout)
    : null
  if (identity?.status !== 0 || identity?.error !== undefined || identity?.signal !== null
    || match === null) throw new Error('installed_candidate_invalid')
  const ownership = run(win32.join(systemRoot, 'System32', 'icacls.exe'), [
    home, '/setowner', `*${match[1]}`, '/Q',
  ], options)
  if (ownership?.status !== 0 || ownership?.error !== undefined || ownership?.signal !== null) {
    throw new Error('installed_candidate_invalid')
  }
}
