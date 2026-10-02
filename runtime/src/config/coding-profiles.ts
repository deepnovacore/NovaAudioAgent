import {createHash} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {ACP_BACKEND_IDS, type AcpBackendId} from './coding-backends.js'

/** Codex sessions keep the app-server's own home semantics under one fixed profile. */
export const CODEX_PROFILE_ID = 'codex:legacy'

/** A host-approved configuration source reference, never a credential or config contents. */
export interface CodingProfile {
  readonly backendId: AcpBackendId
  readonly binaryPath: string
  readonly configPath: string
}

export interface RuntimeCodingProfile {
  readonly backendId: AcpBackendId
  readonly binaryPath: string
  readonly environment: NodeJS.ProcessEnv
}

export interface CodingProfileRegistry {
  readonly defaults: Readonly<Record<AcpBackendId, string>>
  readonly profiles: Readonly<Record<string, CodingProfile>>
}

/** Per-backend ACP executable override, e.g. `OPENCODE_ACP_BIN`. */
export function acpBinaryEnvironmentName(backendId: AcpBackendId): string {
  return `${backendId.toUpperCase()}_ACP_BIN`
}

// Only source locations inherited by ACP profiles; never hash credentials or config contents.
const CONFIG_SOURCE_ENV = ['HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'] as const
const BACKEND_CONFIG_ENV: Readonly<Record<AcpBackendId, readonly string[]>> = {
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'], codebuddy: [], pi: ['PI_CODING_AGENT_DIR'], deepseek: ['DSH_HOME'],
}
const CONFIG_PATH_BACKENDS: ReadonlySet<AcpBackendId> = new Set(['opencode', 'pi', 'deepseek'])

const defaultProfileId = (backendId: AcpBackendId): string => `${backendId}:default`

/**
 * Rebuild the available identities from effective sources. An identity changes whenever the
 * binary or any config-source location changes, so a drifted session is refused rather than
 * resumed against a different account; ordinary token refresh does not rebind.
 */
export function runtimeCodingProfiles(registry: CodingProfileRegistry, environment: NodeJS.ProcessEnv): {
  readonly defaults: Readonly<Record<AcpBackendId, string>>
  readonly profiles: Readonly<Record<string, RuntimeCodingProfile>>
} {
  const defaults = {...registry.defaults}
  const profiles: Record<string, RuntimeCodingProfile> = Object.create(null) as Record<string, RuntimeCodingProfile>
  const builtin: Record<string, CodingProfile> = Object.fromEntries(ACP_BACKEND_IDS.map(backendId => [defaultProfileId(backendId), {
    backendId, binaryPath: environment[acpBinaryEnvironmentName(backendId)] ?? '', configPath: '',
  }]))
  for (const [settingsId, profile] of Object.entries({...builtin, ...registry.profiles})) {
    const env = {...environment}
    if (profile.configPath) {
      const key = BACKEND_CONFIG_ENV[profile.backendId][0]
      if (key !== undefined) env[key] = profile.configPath
    }
    const sources = Object.fromEntries([...CONFIG_SOURCE_ENV, ...BACKEND_CONFIG_ENV[profile.backendId]]
      .map(key => [key, env[key] ?? null]))
    const id = `${profile.backendId}:source-v1:${createHash('sha256')
      .update(JSON.stringify({backendId: profile.backendId, binaryPath: profile.binaryPath, sources})).digest('hex')}`
    profiles[id] = Object.freeze({backendId: profile.backendId, binaryPath: profile.binaryPath, environment: Object.freeze(env)})
    if (registry.defaults[profile.backendId] === settingsId) defaults[profile.backendId] = id
  }
  return {defaults: Object.freeze(defaults), profiles: Object.freeze(profiles)}
}

/** Parse the host-private `CODING_PROFILES` document; every profile id is its content hash. */
export function parseCodingProfiles(raw?: string): CodingProfileRegistry {
  const defaults = Object.fromEntries(ACP_BACKEND_IDS.map(id => [id, defaultProfileId(id)])) as Record<AcpBackendId, string>
  const profiles: Record<string, CodingProfile> = Object.create(null) as Record<string, CodingProfile>
  if (raw === undefined || raw === '') return {defaults, profiles}
  const fail = (): never => { throw new Error('invalid_coding_profiles') }
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    return value as Record<string, unknown>
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return fail() }
  const document = record(parsed)
  if (Object.keys(document).sort().join(',') !== 'defaults,profiles') return fail()
  for (const [id, value] of Object.entries(record(document.profiles))) {
    const source = record(value)
    if (Object.keys(source).sort().join(',') !== 'backendId,binaryPath,configPath') return fail()
    const {backendId, binaryPath, configPath} = source
    if (!ACP_BACKEND_IDS.includes(backendId as AcpBackendId)) return fail()
    for (const path of [binaryPath, configPath]) {
      if (typeof path !== 'string' || (path !== '' && !isAbsolute(path)) || /[\x00-\x1f\x7f]/u.test(path)) return fail()
    }
    if (configPath && !CONFIG_PATH_BACKENDS.has(backendId as AcpBackendId)) return fail()
    const profile = {backendId, binaryPath, configPath} as CodingProfile
    const expected = `${profile.backendId}:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`
    if (id !== expected) return fail()
    profiles[id] = Object.freeze(profile)
  }
  const selected = record(document.defaults)
  if (Object.keys(selected).sort().join(',') !== [...ACP_BACKEND_IDS].sort().join(',')) return fail()
  for (const backend of ACP_BACKEND_IDS) {
    const id = selected[backend]
    if (typeof id !== 'string' || (id !== defaults[backend] && profiles[id]?.backendId !== backend)) return fail()
    defaults[backend] = id
  }
  return {defaults, profiles: Object.freeze(profiles)}
}
