import {readFileSync, statSync} from 'node:fs'
import {mkdir, rename, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {homedir} from 'node:os'
import {createHmac, randomBytes, randomUUID} from 'node:crypto'
import {parseCapabilityRegistry, capabilityStatus, probeMcpServer, SensitiveContentPolicy, MCP_NON_AUTH_HEADERS} from '@nova-audio-agent/runtime/desktop'
export {capabilityEnvironment} from './backend.mjs'

const MAX_BYTES = 256 * 1024
const policy = new SensitiveContentPolicy()
const PUBLIC_IDENTITY_ENV = new Set(['HOME', 'USER', 'USERPROFILE', 'USERNAME', 'LOGNAME'])
const CAPABILITY_REVISION_KEY = randomBytes(32)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function invalidCommit(reason = 'invalid_document') {
  return Object.assign(new Error('invalid settings commit'), {code: 'invalid_settings_commit', problems: [reason]})
}
export function capabilityDocumentRevision(settings, environment = {}) {
  const path = capabilityPath(settings, environment)
  try {
    const bytes = readFileSync(path)
    if (bytes.byteLength > MAX_BYTES) throw invalidCommit('file_too_large')
    return createHmac('sha256', CAPABILITY_REVISION_KEY).update(path).update('\0').update(bytes).digest('base64url')
  } catch (error) {
    if (error.code === 'ENOENT') return createHmac('sha256', CAPABILITY_REVISION_KEY).update(path).update('\0missing').digest('base64url')
    throw error
  }
}
export function parseSettingsCommit(value) {
  if (!record(value) || Object.keys(value).some(key => !['settingsPatch', 'capabilitiesDocument', 'capabilitiesBaseRevision'].includes(key))
    || (value.settingsPatch !== undefined && !record(value.settingsPatch))
    || (Object.hasOwn(value, 'capabilitiesDocument') && !record(value.capabilitiesDocument))
    || (Object.hasOwn(value, 'capabilitiesDocument') && (typeof value.capabilitiesBaseRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.capabilitiesBaseRevision)))
    || (!Object.hasOwn(value, 'capabilitiesDocument') && Object.hasOwn(value, 'capabilitiesBaseRevision'))) throw invalidCommit('invalid_payload')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES * 2) throw invalidCommit('payload_too_large')
  return value
}
export function validatePreparedSettings(patch, next) {
  function compare(submitted, actual) {
    for (const [key, value] of Object.entries(submitted)) {
      if (key === 'secrets') {
        if (!record(value)) throw invalidCommit('invalid_settings_patch')
        continue
      }
      if (key === 'version' || !Object.hasOwn(actual, key)) throw invalidCommit('invalid_settings_patch')
      if (record(value) && record(actual[key])) compare(value, actual[key])
      else if (value !== actual[key] && !(typeof value === 'string' && value.trim() === actual[key])) throw invalidCommit('invalid_settings_patch')
    }
  }
  compare(patch ?? {}, next)
}
export function capabilityPath(settings, environment = {}, home = homedir()) {
  const raw = settings?.capabilitiesConfigPath?.trim() || environment.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG?.trim() || '~/.nova-audio-agent/capabilities.json'
  return raw.startsWith('~/') ? join(home, raw.slice(2)) : resolve(raw)
}
export function readCapabilityDocument(settings, environment = {}) {
  const path = capabilityPath(settings, environment)
  try {
    const bytes = readFileSync(path)
    if (bytes.byteLength > MAX_BYTES) throw invalidCommit('file_too_large')
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && !settings?.capabilitiesConfigPath?.trim() && !environment.NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG?.trim()) return {version: 1}
    throw invalidCommit('file_unreadable_or_invalid_json')
  }
}
function withoutReferences(value) {
  const plain = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/gu, '')
  if (!value.includes('${') || !plain.startsWith('http')) return plain
  try {
    const url = new URL(plain)
    for (const [key, item] of [...url.searchParams]) if (!item) url.searchParams.delete(key)
    return url.href
  } catch { return plain }
}
/** Raw files are untrusted too. Refuse unsafe documents visibly; never silently rewrite secrets. */
export function assertEditorSafe(document, knownSecrets = []) {
  const raw = JSON.stringify(document)
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) throw invalidCommit('invalid_or_oversized_document')
  if (knownSecrets.some(secret => secret && raw.includes(secret))) throw invalidCommit('inline_credentials_use_env')
  function visit(value) {
    if (typeof value === 'string') {
      if (policy.scrub('capability', withoutReferences(value)).kind !== 'clean') throw invalidCommit('inline_credentials_use_env')
    } else if (record(value)) {
      for (const field of ['headers', 'env']) {
        if (record(value[field])) for (const [key, item] of Object.entries(value[field])) {
          if (typeof item === 'string' && item) {
            const literal = withoutReferences(item).trim()
            if (literal !== '' && !(field === 'headers' && (literal === 'Bearer' || MCP_NON_AUTH_HEADERS.includes(key.toLowerCase())))) throw invalidCommit('headers_env_require_references')
          }
        }
      }
      if (typeof value.command === 'string' && policy.scrubCommand(withoutReferences(value.command),
        Array.isArray(value.args) ? value.args.filter(item => typeof item === 'string').map(withoutReferences) : []).kind !== 'clean') throw invalidCommit('inline_credentials_use_env')
      for (const [key, item] of Object.entries(value)) {visit(key); visit(item)}
    } else if (Array.isArray(value)) for (const item of value) visit(item)
  }
  visit(document)
}
export function referencedCapabilitySecrets(document, environment) {
  const names = new Set()
  function visit(value, publicIdentity = false) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
        // Only identity-to-identity stdio env forwarding is public. The same name
        // in a URL/auth header/unknown env slot remains sensitive, including CUSTOM_AUTH.
        if (!publicIdentity || !PUBLIC_IDENTITY_ENV.has(match[1])) names.add(match[1])
      }
    } else if (record(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'env' && record(item)) {
          for (const [name, text] of Object.entries(item)) visit(text, PUBLIC_IDENTITY_ENV.has(name))
        } else visit(item)
      }
    } else if (Array.isArray(value)) for (const item of value) visit(item)
  }
  visit(document)
  return [...new Set([...names].map(name => environment[name]).filter(value => typeof value === 'string' && value))]
}
export function readCapabilityEditor(settings, environment = {}, knownSecrets = []) {
  const path = capabilityPath(settings, environment)
  let revision
  try { revision = capabilityDocumentRevision(settings, environment) }
  catch (error) { return {path, document: null, status: null, problems: error.problems ?? ['invalid_capabilities_configuration']} }
  try {
    const document = readCapabilityDocument(settings, environment)
    assertEditorSafe(document, [...knownSecrets, ...referencedCapabilitySecrets(document, environment)])
    try {
      const registry = parseCapabilityRegistry(document, environment)
      return {path, document, revision, status: capabilityStatus(registry), problems: []}
    } catch { return {path, document, revision, status: null, problems: ['invalid_capabilities_configuration']} }
  } catch (error) {
    return {path, document: null, revision, status: null, problems: error.problems ?? ['invalid_capabilities_configuration']}
  }
}
async function replaceBytes(path, bytes) {
  await mkdir(dirname(path), {recursive: true})
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, bytes, {mode: 0o600})
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}
export async function prepareCapabilityCommit({settings, sourceSettings = settings, document, expectedRevision, environment = {}, knownSecrets = []}) {
  const nextDocument = document ?? readCapabilityDocument(settings, environment)
  assertEditorSafe(nextDocument, [...knownSecrets, ...referencedCapabilitySecrets(nextDocument, environment)])
  let registry
  try { registry = parseCapabilityRegistry(nextDocument, environment) }
  catch (error) { throw invalidCommit(error?.reason ?? 'invalid_capabilities_configuration') }
  const failed = registry.serverStatuses.find(server => server.status === 'failed')
  if (failed) throw invalidCommit(failed.reason ?? 'invalid_mcp_server')
  if (document === undefined) return
  const path = capabilityPath(settings, environment)
  let previous = null
  try { previous = readFileSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (expectedRevision !== undefined) {
    const sourcePath = capabilityPath(sourceSettings, environment)
    if (sourcePath !== path) {
      try { statSync(path); throw invalidCommit('capabilities_document_changed') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    let currentRevision
    try { currentRevision = capabilityDocumentRevision(sourceSettings, environment) }
    catch { throw invalidCommit('capabilities_document_changed') }
    if (expectedRevision !== currentRevision) throw invalidCommit('capabilities_document_changed')
  }
  await replaceBytes(path, Buffer.from(JSON.stringify(document)))
  return {rollback: () => previous === null ? unlink(path) : replaceBytes(path, previous)}
}
export async function publicCapabilityProbe(config, probe = probeMcpServer, knownSecrets = []) {
  const secrets = [...knownSecrets, ...Object.entries(config.env ?? {}).filter(([name]) => !PUBLIC_IDENTITY_ENV.has(name)).map(([, value]) => value), ...Object.entries(config.headers ?? {}).filter(([name]) => !MCP_NON_AUTH_HEADERS.includes(name.toLowerCase())).flatMap(([, value]) => [value, value.replace(/^Bearer\s+/iu, '')])].filter(Boolean)
  const result = await probe(config)
  if (result.status !== 'ok') return {status: 'failed', reason: 'discovery_failed', tools: []}
  const clean = value => {
    let text = String(value).slice(0, 4096)
    for (const secret of secrets) text = text.split(secret).join('[redacted]')
    const scrubbed = policy.scrub('metadata', text)
    return scrubbed.kind === 'clean' ? text : scrubbed.kind === 'redacted' ? scrubbed.value : '[redacted]'
  }
  const tools = []
  for (const tool of result.tools) {
    if (clean(tool.name) !== tool.name) return {status: 'failed', reason: 'metadata_rejected', tools: []}
    tools.push({name: tool.name, description: clean(tool.description ?? ''), readOnlyHint: tool.readOnlyHint === true})
  }
  return {status: 'ok', tools}
}
