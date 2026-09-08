import {closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync} from 'node:fs'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'
import {hostProjectRootFromConfig} from './project-store.js'

export class PrivateDatabaseError extends Error {
  constructor(readonly code: 'STORE_INVALID_INPUT' | 'STORE_WRITE_FAILED') { super(code) }
}

export function preparePrivateDatabasePath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new PrivateDatabaseError('STORE_INVALID_INPUT')
  const file = basename(path)
  if (file === '' || file === '.' || file === '..') throw new PrivateDatabaseError('STORE_INVALID_INPUT')
  const parent = ensurePrivateParent(dirname(path))
  const databasePath = join(parent, file)
  if (databasePath !== path) throw new PrivateDatabaseError('STORE_WRITE_FAILED')
  ensurePrivateDatabaseFile(databasePath)
  return databasePath
}

function ensurePrivateParent(parent: string): string {
  const missing: string[] = []
  let ancestor = parent
  for (;;) {
    try {
      lstatSync(ancestor)
      break
    } catch {
      const next = dirname(ancestor)
      if (next === ancestor) throw new PrivateDatabaseError('STORE_WRITE_FAILED')
      missing.unshift(basename(ancestor))
      ancestor = next
    }
  }
  try { hostProjectRootFromConfig(ancestor) } catch { throw new PrivateDatabaseError('STORE_WRITE_FAILED') }
  let current = realpathSync(ancestor)
  for (const child of missing) {
    const next = join(current, child)
    try { mkdirSync(next, {mode: 0o700}) } catch { /* existing child is validated below */ }
    try { hostProjectRootFromConfig(next) } catch { throw new PrivateDatabaseError('STORE_WRITE_FAILED') }
    current = realpathSync(next)
    if (current !== next) throw new PrivateDatabaseError('STORE_WRITE_FAILED')
  }
  return current
}

function ensurePrivateDatabaseFile(path: string): void {
  let descriptor: number | undefined
  try {
    try {
      const info = lstatSync(path)
      if (info.isSymbolicLink() || !info.isFile() || !privateFile(info)) throw new PrivateDatabaseError('STORE_WRITE_FAILED')
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW)
    } catch (error) {
      if (error instanceof PrivateDatabaseError) throw error
      descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    }
    const fromDescriptor = fstatSync(descriptor)
    const fromPath = lstatSync(path)
    if (!fromDescriptor.isFile() || !privateFile(fromDescriptor) || fromDescriptor.dev !== fromPath.dev || fromDescriptor.ino !== fromPath.ino) {
      throw new PrivateDatabaseError('STORE_WRITE_FAILED')
    }
  } catch (error) {
    if (error instanceof PrivateDatabaseError) throw error
    throw new PrivateDatabaseError('STORE_WRITE_FAILED')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function secureSidecar(databasePath: string, suffix: '-wal' | '-shm'): void {
  const path = `${databasePath}${suffix}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(descriptor)
    if (!info.isFile() || !ownedByCurrentUser(info.uid)) throw new PrivateDatabaseError('STORE_WRITE_FAILED')
    fchmodSync(descriptor, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}

function privateFile(info: {readonly isFile: () => boolean; readonly mode: number; readonly uid: number}): boolean {
  return info.isFile() && ownedByCurrentUser(info.uid) && (process.platform === 'win32' || (info.mode & 0o7777) === 0o600)
}

function ownedByCurrentUser(uid: number): boolean {
  return process.platform === 'win32' || typeof process.getuid !== 'function' || uid === process.getuid()
}
