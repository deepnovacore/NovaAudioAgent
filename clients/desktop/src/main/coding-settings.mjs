import {createHash} from 'node:crypto'
import {accessSync, constants, statSync} from 'node:fs'
import {delimiter, isAbsolute, join} from 'node:path'

/** Every backend a new coding session may use. Codex keeps its app-server configuration below. */
export const CODING_BACKENDS = Object.freeze(['codex', 'opencode', 'codebuddy', 'pi', 'deepseek'])
/** Backends reached through ACP; only these carry desktop-managed path profiles. */
export const ACP_BACKENDS = Object.freeze(['opencode', 'codebuddy', 'pi', 'deepseek'])
const CONFIG_BACKENDS = new Set(['opencode', 'pi', 'deepseek'])
const ACP_COMMANDS = Object.freeze({opencode: 'opencode', codebuddy: 'codebuddy', pi: 'pi-acp', deepseek: 'dsh'})
const pathValue = value => typeof value === 'string' && value.length <= 32768
  && !/[\x00-\x1f\x7f]/u.test(value) && (value === '' || isAbsolute(value)) ? value : null

export function codingProfileId(profile) {
  return !profile.binaryPath && !profile.configPath
    ? `${profile.backendId}:default`
    : `${profile.backendId}:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`
}

export function normalizeCodingPaths(source, fallback) {
  return Object.fromEntries(ACP_BACKENDS.map(id => [id, {
    binaryPath: pathValue(source?.[id]?.binaryPath) ?? pathValue(fallback?.[id]?.binaryPath) ?? '',
    configPath: CONFIG_BACKENDS.has(id) ? pathValue(source?.[id]?.configPath) ?? pathValue(fallback?.[id]?.configPath) ?? '' : '',
  }]))
}

/** Main-only immutable source references; renderer patches cannot rewrite old session profiles. */
export function normalizeCodingProfiles(source) {
  const profiles = {}
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return profiles
  for (const [key, value] of Object.entries(source)) {
    if (!ACP_BACKENDS.includes(value?.backendId) || pathValue(value.binaryPath) === null
      || pathValue(value.configPath) === null || (!CONFIG_BACKENDS.has(value.backendId) && value.configPath !== '')) continue
    const profile = {backendId: value.backendId, binaryPath: value.binaryPath, configPath: value.configPath}
    if (!profile.binaryPath && !profile.configPath) continue
    if (key === codingProfileId(profile)) profiles[key] = profile
  }
  return profiles
}

/** The host-private `CODING_PROFILES` document: every historical profile plus current defaults. */
export function codingProfileRegistry(settings) {
  const paths = normalizeCodingPaths(settings?.codingBackendPaths)
  const profiles = normalizeCodingProfiles(settings?.codingBackendProfiles)
  const defaults = {}
  for (const backendId of ACP_BACKENDS) {
    const profile = {backendId, ...paths[backendId]}
    const id = codingProfileId(profile)
    defaults[backendId] = id
    if (profile.binaryPath || profile.configPath) profiles[id] = profile
  }
  return {defaults, profiles}
}

/** Presence only: login and negotiated ACP readiness are verified by the task preflight. */
export function codingBackendStatus(settings, environment = process.env) {
  const paths = normalizeCodingPaths(settings?.codingBackendPaths)
  return Object.fromEntries(ACP_BACKENDS.map(id => {
    const {binaryPath, configPath} = paths[id]
    const candidates = binaryPath ? [binaryPath] : (environment.PATH ?? environment.Path ?? '').split(delimiter)
      .filter(isAbsolute).flatMap(directory => process.platform === 'win32'
        ? ['', '.exe', '.cmd', '.bat', '.com'].map(ext => join(directory, ACP_COMMANDS[id] + ext))
        : [join(directory, ACP_COMMANDS[id])])
    const installed = candidates.some(path => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
    })
    let configuration = 'native'
    if (configPath) {
      try { const stat = statSync(configPath); configuration = (id === 'opencode' ? stat.isFile() : stat.isDirectory()) ? 'available' : 'missing' }
      catch { configuration = 'missing' }
    }
    return [id, {binary: installed ? 'available' : 'missing', configuration, authentication: 'unverified'}]
  }))
}
