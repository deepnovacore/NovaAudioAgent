import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs'
import {getuid} from 'node:process'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'

import {
  hostBinaryFromConfig,
  hostWorkspaceFromConfig,
} from './codex-process-owner.js'
import type {HostBinary, HostWorkspace} from './codex-process-owner.js'
import {
  hostManagedProjectRootFromConfig,
  hostProjectRootFromConfig,
  type HostManagedProjectRoot,
  type HostProjectRoot,
} from './codex-project-store.js'
import type {Settings} from './config.js'
import {isWellFormed, stripLikePython} from './python-text.js'

const resolvedCodexHostConfigBrand: unique symbol = Symbol('ResolvedCodexHostConfig')
const codexCredentialProfileBrand: unique symbol = Symbol('CodexCredentialProfile')
const credentialValues = new WeakMap<CodexCredentialProfile, string | null>()

export type CodexHostConfigurationCode =
  | 'codex_workspace_missing'
  | 'codex_workspace_invalid'
  | 'codex_binary_invalid'
  | 'codex_host_unavailable'
  | 'codex_project_host_unsupported'
  | 'codex_project_state_invalid'
  | 'codex_managed_root_invalid'

export class CodexHostConfigurationError extends Error {
  constructor(readonly code: CodexHostConfigurationCode) {
    super(code)
    this.name = 'CodexHostConfigurationError'
  }
}

export interface CodexHostCatalog {
  readonly canonicalBinaries: readonly string[]
  readonly canonicalWorkspaces: readonly string[]
  readonly defaultBinary: string | null
  readonly homeDirectory: string
}

export interface CodexCredentialProfile {
  readonly [codexCredentialProfileBrand]: true
}

export interface ResolvedCodexHostConfig {
  readonly [resolvedCodexHostConfigBrand]: true
  readonly binary: HostBinary
  readonly workspace: HostWorkspace
  readonly credential: CodexCredentialProfile
  readonly prewarm: boolean
  readonly workingInterval: number
  readonly stateRoot: HostProjectRoot
  readonly managedRoot: HostManagedProjectRoot
}

export function resolveCodexHostConfig(
  settings: Settings,
  catalog: CodexHostCatalog,
): ResolvedCodexHostConfig | null {
  if (!settings.executors.includes('codex')) return null
  const configuredWorkspace = stripLikePython(settings.codex_workspace ?? '')
  if (configuredWorkspace === '') throw new CodexHostConfigurationError('codex_workspace_missing')
  const safeCatalog = validateCatalog(catalog)
  const workspacePath = expandUserPath(configuredWorkspace, safeCatalog.homeDirectory)
  if (
    safeCatalog.canonicalBinaries.length === 0
    || safeCatalog.canonicalWorkspaces.length === 0
  ) throw new CodexHostConfigurationError('codex_host_unavailable')
  let workspace: HostWorkspace
  try {
    workspace = hostWorkspaceFromConfig(workspacePath, safeCatalog.canonicalWorkspaces)
  } catch {
    throw new CodexHostConfigurationError('codex_workspace_invalid')
  }

  const selector = stripLikePython(settings.codex_bin)
  if (selector === 'codex' && safeCatalog.defaultBinary === null) {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  const selectedBinary = selector === 'codex' ? safeCatalog.defaultBinary : selector
  if (
    selectedBinary === null
    || !isAbsolute(selectedBinary)
    || hasRejectedScriptSuffix(selectedBinary)
  ) throw new CodexHostConfigurationError('codex_binary_invalid')
  let binary: HostBinary
  try {
    binary = hostBinaryFromConfig(selectedBinary, safeCatalog.canonicalBinaries)
  } catch {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }

  const credential = Object.freeze({[codexCredentialProfileBrand]: true as const})
  credentialValues.set(credential, settings.codex_api_key)
  let stateRoot: HostProjectRoot
  try {
    stateRoot = hostProjectRootFromConfig(ensurePrivateDirectory(expandUserPath(
      settings.codex_project_state_root,
      safeCatalog.homeDirectory,
    )))
  } catch {
    throw new CodexHostConfigurationError('codex_project_state_invalid')
  }
  let managedRoot: HostManagedProjectRoot
  try {
    managedRoot = hostManagedProjectRootFromConfig(ensurePrivateDirectory(expandUserPath(
      settings.codex_managed_root,
      safeCatalog.homeDirectory,
    )))
  } catch {
    throw new CodexHostConfigurationError('codex_managed_root_invalid')
  }
  return Object.freeze({
    [resolvedCodexHostConfigBrand]: true as const,
    binary,
    workspace,
    credential,
    prewarm: settings.codex_prewarm,
    workingInterval: settings.codex_working_interval,
    stateRoot,
    managedRoot,
  })
}

/** Internal host accessor; this module is intentionally absent from the runtime root exports. */
export function codexCredentialApiKey(profile: CodexCredentialProfile): string | null {
  const value = credentialValues.get(profile)
  if (value === undefined && !credentialValues.has(profile)) {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
  return value ?? null
}

function validateCatalog(catalog: CodexHostCatalog): CodexHostCatalog {
  try {
    if (
      !Array.isArray(catalog.canonicalBinaries)
      || !Array.isArray(catalog.canonicalWorkspaces)
      || typeof catalog.homeDirectory !== 'string'
      || !isWellFormed(catalog.homeDirectory)
      || !isAbsolute(catalog.homeDirectory)
    ) throw new Error('invalid catalog')
    const homeInfo = lstatSync(catalog.homeDirectory)
    if (
      homeInfo.isSymbolicLink()
      || !homeInfo.isDirectory()
      || realpathSync(catalog.homeDirectory) !== resolve(catalog.homeDirectory)
    ) throw new Error('invalid catalog')
    if (
      catalog.defaultBinary !== null
      && (typeof catalog.defaultBinary !== 'string' || !isWellFormed(catalog.defaultBinary))
    ) throw new Error('invalid catalog')
    for (const values of [catalog.canonicalBinaries, catalog.canonicalWorkspaces]) {
      for (const value of values) {
        if (typeof value !== 'string' || !isWellFormed(value) || !isAbsolute(value)) {
          throw new Error('invalid catalog')
        }
      }
    }
    return catalog
  } catch {
    throw new CodexHostConfigurationError('codex_binary_invalid')
  }
}

export function expandUserPath(configured: string, homeDirectory: string): string {
  const value = stripLikePython(configured)
  if (value === '~') return homeDirectory
  if (value.startsWith('~/')) return join(homeDirectory, value.slice(2))
  return value
}

function ensurePrivateDirectory(path: string): string {
  try {
    lstatSync(path)
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    const name = basename(path)
    if (parent === path || name === '' || name === '.' || name === '..') throw error
    ensurePrivateDirectory(parent)
    createPrivateDirectory(parent, path)
  }
  return path
}

function createPrivateDirectory(parent: string, path: string): void {
  const descriptor = openSync(
    parent,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  let childDescriptor: number | null = null
  try {
    const retainedParent = fstatSync(descriptor, {bigint: true})
    const currentParent = lstatSync(parent, {bigint: true})
    if (
      !retainedParent.isDirectory()
      || !sameIdentity(retainedParent, currentParent)
      || !ownedByCurrentUser(retainedParent.uid)
      || (retainedParent.mode & 0o7022n) !== 0n
      || realpathSync(parent) !== resolve(parent)
    ) throw new Error('unsafe parent')
    mkdirSync(path, {mode: 0o700})
    const created = lstatSync(path, {bigint: true})
    childDescriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const opened = fstatSync(childDescriptor, {bigint: true})
    if (
      !opened.isDirectory()
      || !sameIdentity(created, opened)
      || !ownedByCurrentUser(opened.uid)
      || (opened.mode & 0o7777n) !== 0o700n
    ) throw new Error('unsafe created directory')
    const verified = fstatSync(childDescriptor, {bigint: true})
    const current = lstatSync(path, {bigint: true})
    const verifiedParent = fstatSync(descriptor, {bigint: true})
    const currentParentAfterCreate = lstatSync(parent, {bigint: true})
    if (
      !sameIdentity(opened, verified)
      || !sameIdentity(opened, current)
      || !sameIdentity(retainedParent, verifiedParent)
      || !sameIdentity(retainedParent, currentParentAfterCreate)
      || (verified.mode & 0o7777n) !== 0o700n
      || realpathSync(path) !== resolve(path)
      || dirname(realpathSync(path)) !== realpathSync(parent)
    ) throw new Error('created directory replaced')
  } finally {
    if (childDescriptor !== null) closeSync(childDescriptor)
    closeSync(descriptor)
  }
}

function sameIdentity(
  left: {readonly dev: bigint; readonly ino: bigint},
  right: {readonly dev: bigint; readonly ino: bigint},
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function ownedByCurrentUser(uid: bigint): boolean {
  return typeof getuid !== 'function' || uid === BigInt(getuid())
}

function hasRejectedScriptSuffix(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')
}
