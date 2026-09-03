/**
 * Host-minted path capabilities.
 *
 * A `HostWorkspace` or `HostStateHome` can only be created here, from a canonical absolute native
 * path that exists and passed the caller's allowlist. Executors receive the brand, never the raw
 * string, so a workspace or per-workspace state home that reaches a child process is one the host
 * validated. The values live in WeakMaps keyed by the frozen brand object; a forged object has no
 * entry and every accessor throws.
 */
import {lstatSync, realpathSync, statSync} from 'node:fs'
import {isAbsolute} from 'node:path'

import {isWellFormed} from './python-text.js'

const hostWorkspaceBrand: unique symbol = Symbol('HostWorkspace')
const hostStateHomeBrand: unique symbol = Symbol('HostStateHome')

export interface HostWorkspace { readonly [hostWorkspaceBrand]: true }
export interface HostStateHome { readonly [hostStateHomeBrand]: true }

export type HostPathErrorCode = 'spawn_failed' | 'workspace_invalid'

export interface HostStateHomeValue {
  readonly path: string
  readonly ephemeral: boolean
  identity: EphemeralHomeIdentity | null
  cleanupPath: string | null
}

interface EphemeralHomeIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly uid: number
}

const workspaceValues = new WeakMap<HostWorkspace, string>()
const homeValues = new WeakMap<HostStateHome, HostStateHomeValue>()

export class HostPathError extends Error {
  readonly code: HostPathErrorCode

  constructor(code: HostPathErrorCode) {
    super(code)
    this.name = 'HostPathError'
    this.code = code
  }
}

export function hostWorkspaceFromConfig(
  configured: string,
  allowlistedCanonicalWorkspaces: readonly string[],
): HostWorkspace {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalWorkspaces.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new HostPathError('workspace_invalid')
  }
  return brandWorkspace(canonical)
}

export function hostEphemeralHomeFromConfig(
  configured: string,
  allowlistedCanonicalHomes: readonly string[],
): HostStateHome {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalHomes.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new HostPathError('workspace_invalid')
  }
  return brandHome(canonical, true)
}

export function hostPersistentHomeFromConfig(
  configured: string,
  allowlistedCanonicalHomes: readonly string[],
): HostStateHome {
  const canonical = requireCanonicalDirectory(configured, 'workspace_invalid')
  if (!allowlistedCanonicalHomes.some(candidate => safeCanonicalPath(candidate) === canonical)) {
    throw new HostPathError('workspace_invalid')
  }
  return brandHome(canonical, false)
}

/** Test-only constructors. They still enforce canonical absolute native paths. */
export function hostWorkspaceForTest(configured: string): HostWorkspace {
  return brandWorkspace(requireCanonicalDirectory(configured, 'workspace_invalid'))
}

export function hostHomeForTest(
  configured: string,
  options: {readonly ephemeral: boolean},
): HostStateHome {
  return brandHome(requireCanonicalDirectory(configured, 'workspace_invalid'), options.ephemeral)
}

export function hostWorkspacePath(value: HostWorkspace): string {
  const path = workspaceValues.get(value)
  if (path === undefined) throw new HostPathError('workspace_invalid')
  return path
}

export function hostHomeValue(value: HostStateHome): HostStateHomeValue {
  const home = homeValues.get(value)
  if (home === undefined) throw new HostPathError('workspace_invalid')
  return home
}

/** Internal credential-cleanup capability refresh after creating an approved ephemeral home. */
export function refreshEphemeralHomeIdentity(value: HostStateHome): void {
  const home = homeValues.get(value)
  if (!home?.ephemeral) throw new HostPathError('workspace_invalid')
  home.identity = readEphemeralHomeIdentity(home.path)
  home.cleanupPath = null
}

export function requireCanonicalDirectory(configured: string, code: HostPathErrorCode): string {
  const canonical = requireCanonicalPath(configured, code)
  try {
    if (!statSync(canonical).isDirectory()) throw new Error('not directory')
  } catch {
    throw new HostPathError(code)
  }
  return canonical
}

export function requireCanonicalPath(configured: string, code: HostPathErrorCode): string {
  if (typeof configured !== 'string' || !isWellFormed(configured) || !isAbsolute(configured)) {
    throw new HostPathError(code)
  }
  let canonical: string
  try {
    canonical = realpathSync(configured)
  } catch {
    throw new HostPathError(code)
  }
  if (canonical !== configured) throw new HostPathError(code)
  return canonical
}

export function safeCanonicalPath(candidate: string): string | null {
  try {
    return requireCanonicalPath(candidate, 'workspace_invalid')
  } catch {
    return null
  }
}

function brandWorkspace(path: string): HostWorkspace {
  const value = Object.freeze({[hostWorkspaceBrand]: true as const})
  workspaceValues.set(value, path)
  return value
}

function brandHome(path: string, ephemeral: boolean): HostStateHome {
  const value = Object.freeze({[hostStateHomeBrand]: true as const})
  homeValues.set(value, {
    path,
    ephemeral,
    identity: ephemeral ? readEphemeralHomeIdentity(path) : null,
    cleanupPath: null,
  })
  return value
}

function readEphemeralHomeIdentity(path: string): EphemeralHomeIdentity {
  try {
    const info = lstatSync(path, {bigint: true})
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('invalid home')
    return Object.freeze({device: info.dev, inode: info.ino, uid: Number(info.uid)})
  } catch {
    throw new HostPathError('workspace_invalid')
  }
}
