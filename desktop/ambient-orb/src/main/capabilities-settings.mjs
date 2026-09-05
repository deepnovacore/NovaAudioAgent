import {readFileSync} from 'node:fs'
import {mkdir, rename, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {homedir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {parseCapabilityRegistry, capabilityStatus, probeMcpServer, SensitiveContentPolicy} from '@nova-audio-agent/runtime/desktop'
export {capabilityEnvironment} from './backend.mjs'

const MAX_BYTES = 256 * 1024
const policy = new SensitiveContentPolicy()
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function invalidCommit(reason = 'invalid_document') {
  return Object.assign(new Error('invalid settings commit'), {code: 'invalid_settings_commit', problems: [reason]})
}
export function parseSettingsCommit(value) {
  if (!record(value) || Object.keys(value).some(key => !['settingsPatch', 'capabilitiesDocument'].includes(key))
    || (value.settingsPatch !== undefined && !record(value.settingsPatch))
    || (Object.hasOwn(value, 'capabilitiesDocument') && !record(value.capabilitiesDocument))) throw invalidCommit('invalid_payload')
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
        if (record(value[field])) for (const item of Object.values(value[field])) {
          if (typeof item === 'string' && item) {
            const literal = withoutReferences(item).trim()
            if (literal !== '' && !(field === 'headers' && literal === 'Bearer')) throw invalidCommit('headers_env_require_references')
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
  const names = [...JSON.stringify(document).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)].map(match => match[1])
  return [...new Set(names.map(name => environment[name]).filter(value => typeof value === 'string' && value))]
}
export function readCapabilityEditor(settings, environment = {}, knownSecrets = []) {
  const path = capabilityPath(settings, environment)
  try {
    const document = readCapabilityDocument(settings, environment)
    assertEditorSafe(document, [...knownSecrets, ...referencedCapabilitySecrets(document, environment)])
    try {
      const registry = parseCapabilityRegistry(document, environment)
      return {path, document, status: capabilityStatus(registry), problems: []}
    } catch { return {path, document, status: null, problems: ['invalid_capabilities_configuration']} }
  } catch (error) {
    return {path, document: null, status: null, problems: error.problems ?? ['invalid_capabilities_configuration']}
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
export async function prepareCapabilityCommit({settings, document, environment = {}, knownSecrets = []}) {
  const nextDocument = document ?? readCapabilityDocument(settings, environment)
  assertEditorSafe(nextDocument, knownSecrets)
  let registry
  try { registry = parseCapabilityRegistry(nextDocument, environment) }
  catch (error) { throw invalidCommit(error?.reason ?? 'invalid_capabilities_configuration') }
  const failed = registry.serverStatuses.find(server => server.status === 'failed')
  if (failed) throw invalidCommit(failed.reason ?? 'invalid_mcp_server')
  if (document === undefined) return
  const path = capabilityPath(settings, environment)
  let previous = null
  try { previous = readFileSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await replaceBytes(path, Buffer.from(JSON.stringify(document, null, 2) + '\n'))
  return {rollback: () => previous === null ? unlink(path) : replaceBytes(path, previous)}
}
export async function publicCapabilityProbe(config, probe = probeMcpServer, knownSecrets = []) {
  const secrets = [...knownSecrets, ...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {}).flatMap(value => [value, value.replace(/^Bearer\s+/iu, '')])].filter(Boolean)
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
