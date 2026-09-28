import {normalizeSkinSettings} from '../renderer/orb-skins.mjs'
import {preferredLanguage} from '../renderer/locale.mjs'
import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {isAbsolute, resolve} from 'node:path'

// `normalizeSettings` always rebuilds and stamps the latest shape, so an older file
// keeps its provider choices while gaining packaged-desktop configuration.
export const SETTINGS_VERSION = 4

export const SECRET_KEYS = Object.freeze([
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'deepseekApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
])

export const PALETTES = Object.freeze(['ember', 'graphite'])
export const PROACTIVITY_LEVELS = Object.freeze(['conservative', 'balanced', 'eager'])
export const PIPELINE_MODES = Object.freeze(['integrated', 'cascaded'])
export const INTEGRATED_PROVIDERS = Object.freeze(['qwen'])
export const CASCADED_ENDPOINTING_PROVIDERS = Object.freeze(['auto'])
export const CASCADED_ASR_PROVIDERS = Object.freeze(['volcengine'])
export const CASCADED_LLM_PROVIDERS = Object.freeze(['qwen', 'ark', 'deepseek'])
export const CASCADED_TTS_PROVIDERS = Object.freeze(['volcengine'])
export const HEARTBEAT_MIN_SECONDS = 15
export const HEARTBEAT_MAX_SECONDS = 120
export const MAX_MODEL_OR_VOICE_LENGTH = 64
export const MAX_DESKTOP_SETTING_LENGTH = 32_768
// A key is a token, not a document: anything longer is a paste accident or an
// attempt to grow the settings file, and is refused rather than stored.
export const MAX_SECRET_LENGTH = 4096
const MAX_CIPHERTEXT_BASE64 = 8192

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  language: 'zh-CN',
  palette: 'ember',
  skinId: 'nova',
  importedSkins: Object.freeze([]),
  proactivity: 'balanced',
  codingProgressNarration: 'smart',
  codexHeartbeatSeconds: 30,
  codexBinaryMode: 'auto',
  codexBinaryPath: '',
  codexWorkspace: '',
  codexManagedRoot: '',
  modelBaseUrl: '',
  startListeningOnLaunch: false,
  wakeWordEnabled: false,
  autoHideSeconds: 60,
  pipelineMode: 'integrated',
  integratedProvider: 'qwen',
  integratedModel: 'qwen-audio-3.0-realtime-plus',
  integratedVoice: 'longanqian',
  cascadedEndpointingProvider: 'auto',
  cascadedAsrProvider: 'volcengine',
  cascadedLlmProvider: 'deepseek',
  cascadedLlmModels: Object.freeze({
    qwen: 'qwen-plus',
    ark: 'doubao-seed-2-0-pro-260215',
    deepseek: 'deepseek-flash',
  }),
  cascadedTtsProvider: 'volcengine',
  cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
  codexApprovalMode: 'ask',
  clarificationDepth: 'balanced',
  planReadback: 'summary',
  generatePlan: true,
  plannerModel: '',
  progressBubbles: 'milestones',
  conversationVisionEnabled: false,
  monitorCameraDeviceId: '',
  watchModel: '',
  phoneConnectionEnabled: false,
  phoneServerPort: 0,
  phoneServerTokenFile: '',
  phoneServerUrl: '',
  embeddingProvider: 'dashscope',
  embeddingModel: 'text-embedding-v4',
  capabilitiesConfigPath: '',
  knowledgePath: '',
  secrets: Object.freeze({}),
})

const PALETTE_SET = new Set(PALETTES)
const PROACTIVITY_SET = new Set(PROACTIVITY_LEVELS)
const PIPELINE_MODE_SET = new Set(PIPELINE_MODES)
const INTEGRATED_PROVIDER_SET = new Set(INTEGRATED_PROVIDERS)
const CASCADED_ENDPOINTING_PROVIDER_SET = new Set(CASCADED_ENDPOINTING_PROVIDERS)
const CASCADED_ASR_PROVIDER_SET = new Set(CASCADED_ASR_PROVIDERS)
const CASCADED_LLM_PROVIDER_SET = new Set(CASCADED_LLM_PROVIDERS)
const CASCADED_TTS_PROVIDER_SET = new Set(CASCADED_TTS_PROVIDERS)
const SECRET_KEY_SET = new Set(SECRET_KEYS)
const CODEX_BINARY_MODES = new Set(['auto', 'manual'])
const CODEX_APPROVAL_MODES = new Set(['ask', 'yolo'])
const CLARIFICATION_DEPTHS = new Set(['minimal', 'balanced', 'thorough'])
const PLAN_READBACK_MODES = new Set(['summary', 'confirm', 'silent'])
const PROGRESS_BUBBLE_MODES = new Set(['off', 'milestones', 'all'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
// Control characters would survive into an env value handed to a child process.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// Files are JSON and Electron IPC structured-clones settings patches.
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Each validator answers the value it accepts, or null. `pick` then walks
// candidate → caller's base → schema default, so one bad field never drags a
// whole file back to defaults and a corrupt base cannot outvote the schema.
function pick(candidate, base, defaultValue, validate) {
  const chosen = validate(candidate)
  if (chosen !== null) return chosen
  const kept = validate(base)
  return kept === null ? defaultValue : kept
}

function validPalette(value) {
  return PALETTE_SET.has(value) ? value : null
}

function validProactivity(value) {
  return PROACTIVITY_SET.has(value) ? value : null
}

function validHeartbeat(value) {
  if (!Number.isInteger(value)) return null
  if (value < HEARTBEAT_MIN_SECONDS || value > HEARTBEAT_MAX_SECONDS) return null
  return value
}

function enumValidator(values) {
  return value => values.has(value) ? value : null
}

const validPipelineMode = enumValidator(PIPELINE_MODE_SET)
const validIntegratedProvider = enumValidator(INTEGRATED_PROVIDER_SET)
const validCascadedEndpointingProvider = enumValidator(CASCADED_ENDPOINTING_PROVIDER_SET)
const validCascadedAsrProvider = enumValidator(CASCADED_ASR_PROVIDER_SET)
const validCascadedLlmProvider = enumValidator(CASCADED_LLM_PROVIDER_SET)
const validCascadedTtsProvider = enumValidator(CASCADED_TTS_PROVIDER_SET)
const validCodexApprovalMode = enumValidator(CODEX_APPROVAL_MODES)
const validClarificationDepth = enumValidator(CLARIFICATION_DEPTHS)
const validPlanReadback = enumValidator(PLAN_READBACK_MODES)
const validProgressBubbles = enumValidator(PROGRESS_BUBBLE_MODES)
function validEmbeddingProvider(value) {
  if (typeof value !== 'string') return null
  if (value !== 'dashscope') throw Object.assign(new Error('embeddingProvider: allowed value is dashscope'), {code: 'embedding_provider_invalid'})
  return value
}

function validModelOrVoice(value) {
  if (typeof value !== 'string') return null
  if (CONTROL_CHARACTERS.test(value)) return null
  const trimmed = value.trim()
  if (trimmed === '' || [...trimmed].length > MAX_MODEL_OR_VOICE_LENGTH) return null
  return trimmed
}

function validBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function validCodexBinaryMode(value) {
  return CODEX_BINARY_MODES.has(value) ? value : null
}

function validDesktopString(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return null
  const trimmed = value.trim()
  return [...trimmed].length <= MAX_DESKTOP_SETTING_LENGTH ? trimmed : null
}

export function validModelBaseUrl(value) {
  const normalized = validDesktopString(value)
  if (normalized === null || normalized === '') return normalized
  try {
    const parsed = new URL(normalized)
    if (parsed.username !== '' || parsed.password !== '') return null
    if (parsed.protocol === 'https:') return normalized
    if (parsed.protocol !== 'http:') return null
    return ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
      ? normalized
      : null
  } catch {
    return null
  }
}

function validPhoneServerUrl(value) {
  const text = validDesktopString(value)
  if (text === null || text === '') return text
  if (text.length > 2048) return null
  try {
    const url = new URL(text)
    return url.protocol === 'wss:' && url.hostname && !url.username && !url.password && !url.search && !url.hash
      && ['', '/', '/client/v1'].includes(url.pathname) ? text : null
  } catch { return null }
}

function normalizeCascadedLlmModels(raw, base) {
  const source = isRecord(raw) ? raw : {}
  const fallback = isRecord(base) ? base : DEFAULT_SETTINGS.cascadedLlmModels
  return {
    qwen: pick(source.qwen, fallback.qwen, DEFAULT_SETTINGS.cascadedLlmModels.qwen, validModelOrVoice),
    deepseek: pick(source.deepseek, fallback.deepseek, DEFAULT_SETTINGS.cascadedLlmModels.deepseek, validModelOrVoice),
    ark: pick(source.ark, fallback.ark, DEFAULT_SETTINGS.cascadedLlmModels.ark, validModelOrVoice),
  }
}

// Stored form only: `{enc, data}` where data is base64 ciphertext. Plaintext
// never has this shape, so a plaintext value that somehow reached the file is
// dropped rather than round-tripped.
function validSecretEntry(entry) {
  if (!isRecord(entry)) return null
  const enc = entry.enc
  const data = entry.data
  if (enc !== 'safeStorage' && enc !== 'none') return null
  if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT_BASE64) return null
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null
  return { enc, data }
}

function normalizeSecrets(raw) {
  const secrets = {}
  if (!isRecord(raw)) return secrets
  for (const key of SECRET_KEYS) {
    const entry = validSecretEntry(raw[key])
    if (entry) secrets[key] = entry
  }
  return secrets
}

// Rebuilds the object rather than editing it: unknown keys have no path
// into the result, whatever the file on disk happens to contain.
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
  const source = isRecord(raw) ? raw : {}
  const fallback = isRecord(base) ? base : DEFAULT_SETTINGS
  const rawVersion = source.version
  const baseVersion = fallback.version
  const acceptsV4Fields = !Object.hasOwn(source, 'version')
    ? !Object.hasOwn(fallback, 'version')
      || (typeof baseVersion === 'number' && baseVersion >= SETTINGS_VERSION)
    : typeof rawVersion === 'number' && rawVersion >= SETTINGS_VERSION
  return {
    version: SETTINGS_VERSION,
    ...normalizeSkinSettings(source, fallback),
    language: pick(source.language, fallback.language, DEFAULT_SETTINGS.language, value => ['zh-CN', 'en'].includes(value) ? value : null),
    palette: pick(source.palette, fallback.palette, DEFAULT_SETTINGS.palette, validPalette),
    codingProgressNarration: pick(source.codingProgressNarration, fallback.codingProgressNarration, DEFAULT_SETTINGS.codingProgressNarration, value => value === 'smart' || value === 'continuous' ? value : null),
    proactivity: pick(source.proactivity, fallback.proactivity, DEFAULT_SETTINGS.proactivity, validProactivity),
    codexHeartbeatSeconds: pick(source.codexHeartbeatSeconds, fallback.codexHeartbeatSeconds, DEFAULT_SETTINGS.codexHeartbeatSeconds, validHeartbeat),
    codexBinaryMode: pick(source.codexBinaryMode, fallback.codexBinaryMode, DEFAULT_SETTINGS.codexBinaryMode, validCodexBinaryMode),
    codexBinaryPath: pick(source.codexBinaryPath, fallback.codexBinaryPath, DEFAULT_SETTINGS.codexBinaryPath, validDesktopString),
    codexWorkspace: pick(source.codexWorkspace, fallback.codexWorkspace, DEFAULT_SETTINGS.codexWorkspace, validDesktopString),
    codexManagedRoot: pick(source.codexManagedRoot, fallback.codexManagedRoot, DEFAULT_SETTINGS.codexManagedRoot, validDesktopString),
    modelBaseUrl: pick(source.modelBaseUrl, fallback.modelBaseUrl, DEFAULT_SETTINGS.modelBaseUrl, validModelBaseUrl),
    wakeWordEnabled: pick(
      source.wakeWordEnabled,
      fallback.wakeWordEnabled, false, validBoolean,
    ),
    autoHideSeconds: pick(
      source.autoHideSeconds,
      fallback.autoHideSeconds, 60,
      value => Number.isInteger(value) && (value === 0 || value >= 30 && value <= 3600) ? value : null,
    ),
    startListeningOnLaunch: pick(source.startListeningOnLaunch, fallback.startListeningOnLaunch, DEFAULT_SETTINGS.startListeningOnLaunch, validBoolean),
    pipelineMode: pick(source.pipelineMode, fallback.pipelineMode, DEFAULT_SETTINGS.pipelineMode, validPipelineMode),
    integratedProvider: pick(source.integratedProvider, fallback.integratedProvider, DEFAULT_SETTINGS.integratedProvider, validIntegratedProvider),
    integratedModel: pick(source.integratedModel, fallback.integratedModel, DEFAULT_SETTINGS.integratedModel, validModelOrVoice),
    integratedVoice: pick(source.integratedVoice, fallback.integratedVoice, DEFAULT_SETTINGS.integratedVoice, validModelOrVoice),
    cascadedEndpointingProvider: pick(source.cascadedEndpointingProvider, fallback.cascadedEndpointingProvider, DEFAULT_SETTINGS.cascadedEndpointingProvider, validCascadedEndpointingProvider),
    cascadedAsrProvider: pick(source.cascadedAsrProvider, fallback.cascadedAsrProvider, DEFAULT_SETTINGS.cascadedAsrProvider, validCascadedAsrProvider),
    cascadedLlmProvider: pick(source.cascadedLlmProvider, fallback.cascadedLlmProvider, DEFAULT_SETTINGS.cascadedLlmProvider, validCascadedLlmProvider),
    cascadedLlmModels: normalizeCascadedLlmModels(
      source.cascadedLlmModels,
      fallback.cascadedLlmModels,
    ),
    cascadedTtsProvider: pick(source.cascadedTtsProvider, fallback.cascadedTtsProvider, DEFAULT_SETTINGS.cascadedTtsProvider, validCascadedTtsProvider),
    cascadedTtsVoice: pick(source.cascadedTtsVoice, fallback.cascadedTtsVoice, DEFAULT_SETTINGS.cascadedTtsVoice, validModelOrVoice),
    codexApprovalMode: pick(acceptsV4Fields ? source.codexApprovalMode : undefined, acceptsV4Fields ? fallback.codexApprovalMode : undefined, DEFAULT_SETTINGS.codexApprovalMode, validCodexApprovalMode),
    clarificationDepth: pick(acceptsV4Fields ? source.clarificationDepth : undefined, acceptsV4Fields ? fallback.clarificationDepth : undefined, DEFAULT_SETTINGS.clarificationDepth, validClarificationDepth),
    generatePlan: pick(source.generatePlan, fallback.generatePlan, DEFAULT_SETTINGS.generatePlan, validBoolean),
    planReadback: pick(acceptsV4Fields ? source.planReadback : undefined, acceptsV4Fields ? fallback.planReadback : undefined, DEFAULT_SETTINGS.planReadback, validPlanReadback),
    plannerModel: pick(acceptsV4Fields ? source.plannerModel : undefined, acceptsV4Fields ? fallback.plannerModel : undefined, DEFAULT_SETTINGS.plannerModel, validDesktopString),
    progressBubbles: pick(acceptsV4Fields ? source.progressBubbles : undefined, acceptsV4Fields ? fallback.progressBubbles : undefined, DEFAULT_SETTINGS.progressBubbles, validProgressBubbles),
    conversationVisionEnabled: pick(source.conversationVisionEnabled, fallback.conversationVisionEnabled, DEFAULT_SETTINGS.conversationVisionEnabled, validBoolean),
    monitorCameraDeviceId: pick(source.monitorCameraDeviceId, fallback.monitorCameraDeviceId, DEFAULT_SETTINGS.monitorCameraDeviceId, value => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f]/u.test(value) ? value : null),
    watchModel: pick(source.watchModel, fallback.watchModel, DEFAULT_SETTINGS.watchModel, validModelOrVoice),
    phoneConnectionEnabled: pick(source.phoneConnectionEnabled, fallback.phoneConnectionEnabled, false, validBoolean),
    phoneServerPort: pick(source.phoneServerPort, fallback.phoneServerPort, 0, value => Number.isInteger(value) && value >= 0 && value <= 65535 ? value : null),
    phoneServerTokenFile: pick(source.phoneServerTokenFile, fallback.phoneServerTokenFile, '', value => { const path = validDesktopString(value); return path !== null && (path === '' || isAbsolute(path)) ? path : null }),
    phoneServerUrl: pick(source.phoneServerUrl, fallback.phoneServerUrl, '', validPhoneServerUrl),
    embeddingProvider: pick(acceptsV4Fields ? source.embeddingProvider : undefined, acceptsV4Fields ? fallback.embeddingProvider : undefined, DEFAULT_SETTINGS.embeddingProvider, validEmbeddingProvider),
    embeddingModel: pick(acceptsV4Fields ? source.embeddingModel : undefined, acceptsV4Fields ? fallback.embeddingModel : undefined, DEFAULT_SETTINGS.embeddingModel, validDesktopString),
    capabilitiesConfigPath: pick(acceptsV4Fields ? source.capabilitiesConfigPath : undefined, acceptsV4Fields ? fallback.capabilitiesConfigPath : undefined, DEFAULT_SETTINGS.capabilitiesConfigPath, validDesktopString),
    knowledgePath: pick(acceptsV4Fields ? source.knowledgePath : undefined, acceptsV4Fields ? fallback.knowledgePath : undefined, DEFAULT_SETTINGS.knowledgePath, validDesktopString),
    secrets: normalizeSecrets(source.secrets),
  }
}

export function backendSettings(settings) {
  const {skinId, importedSkins, palette, wakeWordEnabled, autoHideSeconds, codingProgressNarration, phoneConnectionEnabled, phoneServerPort, phoneServerTokenFile, phoneServerUrl, ...backend} = normalizeSettings(settings)
  return backend
}

// The renderer's whole view of the settings: no secrets object, not even an
// empty one, so no future edit can widen it by accident.
export function publicSettings(settings) {
  const normalized = normalizeSettings(settings)
  return {
    version: normalized.version,
    language: normalized.language,
    palette: normalized.palette,
    skinId: normalized.skinId,
    importedSkins: normalized.importedSkins,
    proactivity: normalized.proactivity,
    codingProgressNarration: normalized.codingProgressNarration,
    codexHeartbeatSeconds: normalized.codexHeartbeatSeconds,
    codexBinaryMode: normalized.codexBinaryMode,
    codexBinaryPath: normalized.codexBinaryPath,
    codexWorkspace: normalized.codexWorkspace,
    codexManagedRoot: normalized.codexManagedRoot,
    modelBaseUrl: normalized.modelBaseUrl,
    startListeningOnLaunch: normalized.startListeningOnLaunch,
    wakeWordEnabled: normalized.wakeWordEnabled,
    autoHideSeconds: normalized.autoHideSeconds,
    pipelineMode: normalized.pipelineMode,
    integratedProvider: normalized.integratedProvider,
    integratedModel: normalized.integratedModel,
    integratedVoice: normalized.integratedVoice,
    cascadedEndpointingProvider: normalized.cascadedEndpointingProvider,
    cascadedAsrProvider: normalized.cascadedAsrProvider,
    cascadedLlmProvider: normalized.cascadedLlmProvider,
    cascadedLlmModels: { ...normalized.cascadedLlmModels },
    cascadedTtsProvider: normalized.cascadedTtsProvider,
    cascadedTtsVoice: normalized.cascadedTtsVoice,
    codexApprovalMode: normalized.codexApprovalMode,
    clarificationDepth: normalized.clarificationDepth,
    planReadback: normalized.planReadback,
    generatePlan: normalized.generatePlan,
    plannerModel: normalized.plannerModel,
    progressBubbles: normalized.progressBubbles,
    conversationVisionEnabled: normalized.conversationVisionEnabled,
    monitorCameraDeviceId: normalized.monitorCameraDeviceId,
    watchModel: normalized.watchModel,
    phoneConnectionEnabled: normalized.phoneConnectionEnabled,
    phoneServerPort: normalized.phoneServerPort,
    phoneServerTokenFile: normalized.phoneServerTokenFile,
    phoneServerUrl: normalized.phoneServerUrl,
    embeddingProvider: normalized.embeddingProvider,
    embeddingModel: normalized.embeddingModel,
    capabilitiesConfigPath: normalized.capabilitiesConfigPath,
    knowledgePath: normalized.knowledgePath,
  }
}

export function orbSettings(settings) {
  const normalized = normalizeSettings(settings)
  return Object.freeze({
    progressBubbles: normalized.progressBubbles,
    codingProgressNarration: normalized.codingProgressNarration,
    language: normalized.language,
    palette: normalized.palette,
    skinId: normalized.skinId,
    importedSkins: normalized.importedSkins,
    conversationVisionEnabled: normalized.conversationVisionEnabled,
    startListeningOnLaunch: normalized.startListeningOnLaunch,
    wakeWordEnabled: normalized.wakeWordEnabled,
    autoHideSeconds: normalized.autoHideSeconds,
  })
}

export function secretsPresent(settings) {
  const { secrets } = normalizeSettings(settings)
  const present = {}
  for (const key of SECRET_KEYS) present[key] = Boolean(secrets[key])
  return present
}

// The only Electron-aware factory in the module, and it is never called by the
// tests with a real safeStorage: everything below takes the codec as an
// argument, and `platform` is a parameter so the linux branch is exercised from
// any host.
export function createSafeStorageCodec(safeStorage, platform = process.platform) {
  return {
    available: () => {
      try {
        if (safeStorage.isEncryptionAvailable() !== true) return false
        if (platform !== 'linux') return true
        // Linux only: with no keyring on the session bus Electron falls back to
        // the `basic_text` backend, which "encrypts" with a hardcoded password
        // — anyone with the file can read the key, so it is not protection and
        // must not silence the panel's plaintext warning. An Electron too old
        // to name its backend cannot prove otherwise, so it counts the same
        // way: unprotected.
        if (typeof safeStorage.getSelectedStorageBackend !== 'function') return false
        return safeStorage.getSelectedStorageBackend() !== 'basic_text'
      } catch {
        return false
      }
    },
    encrypt: plaintext => safeStorage.encryptString(plaintext),
    decrypt: ciphertext => safeStorage.decryptString(Buffer.from(ciphertext)),
  }
}

// Shared with the spawn-time injection guard in main.mjs: Node refuses a C0
// control character (NUL above all) in a child process's environment value, so
// a secret carrying one would fail the very launch that needs it — and the app
// would quit before the panel could clear the offending key. Such a value is
// refused at the door instead of stored.
export function secretValueIsSafe(value) {
  return typeof value === 'string' && !CONTROL_CHARACTERS.test(value)
}

// Whether the file is plaintext-equivalent *as stored*, which is not the same
// question as whether a keyring is available right now: an entry written before
// the keyring appeared stays readable by anyone until some later save re-seals
// it, and the panel must keep saying so until then.
export function hasPlaintextSecret(settings) {
  const { secrets } = normalizeSettings(settings)
  return SECRET_KEYS.some(key => secrets[key]?.enc === 'none')
}

function sealSecret(plaintext, codec) {
  if (codec && codec.available()) {
    return { enc: 'safeStorage', data: Buffer.from(codec.encrypt(plaintext)).toString('base64') }
  }
  // No keyring (Linux without one): the value is still stored, but the panel is
  // told so it can say out loud that this file is now plaintext-equivalent.
  return { enc: 'none', data: Buffer.from(plaintext, 'utf8').toString('base64') }
}

// Plaintext lives only inside this call: `updates` values are consumed into the
// sealed form and never retained. `rejected` collects the key *names* (never
// values) of any field this call refused, so the caller — and eventually the
// panel — can say which paste failed instead of the save looking silently
// successful while that one field quietly kept its old value.
function updatedSecrets(stored, updates, codec) {
  const secrets = { ...stored }
  const rejected = []
  if (!isRecord(updates)) return { secrets, rejected }
  for (const key of SECRET_KEYS) {
    const value = updates[key]
    if (!Object.hasOwn(updates, key)) continue
    if (typeof value !== 'string' || [...value].length > MAX_SECRET_LENGTH) {
      rejected.push(key)
      continue
    }
    if (value === '') {
      delete secrets[key]
      continue
    }
    // Per field, like every other validator here: an unusable key is refused on
    // its own and the rest of the patch still lands.
    if (!secretValueIsSafe(value)) {
      rejected.push(key)
      continue
    }
    const sealed = validSecretEntry(sealSecret(value, codec))
    if (sealed === null) {
      rejected.push(key)
      continue
    }
    secrets[key] = sealed
  }
  return { secrets, rejected }
}

// Opportunistic migration, run on every update so it costs nothing extra and
// lands atomically with that save: a machine that has since grown a keyring
// stops carrying entries the old one wrote in the clear. Each key stands alone
// — a re-seal that throws leaves that entry exactly as it was, because a lost
// key is worse than a plaintext one.
function resealPlaintext(secrets, codec) {
  if (!codec || !codec.available()) return secrets
  const migrated = { ...secrets }
  for (const key of SECRET_KEYS) {
    const entry = migrated[key]
    if (!entry || entry.enc !== 'none') continue
    try {
      const sealed = validSecretEntry(
        sealSecret(Buffer.from(entry.data, 'base64').toString('utf8'), codec),
      )
      if (sealed !== null) migrated[key] = sealed
    } catch {
      // Keep what is stored: the next save tries again.
    }
  }
  return migrated
}

// `patch` is renderer-shaped: non-secret fields plus optional *plaintext*
// secrets. Anything it fails to justify keeps the stored value. `rejectedSecrets`
// rides on the returned object as an extra, additive field — never persisted,
// since `saveSettings` normalizes before writing and the schema doesn't carry
// it — naming (by key only) which secret fields in *this* patch were refused,
// so a caller can tell "silently kept the old value" apart from "saved".
export function applySettingsUpdate(current, patch, codec) {
  const stored = normalizeSettings(current)
  const source = isRecord(patch) ? patch : {}
  const next = normalizeSettings({...source, version: stored.version}, stored)
  const { secrets, rejected } = updatedSecrets(
    stored.secrets,
    source.secrets,
    codec,
  )
  next.secrets = resealPlaintext(secrets, codec)
  next.rejectedSecrets = rejected
  return next
}

// One queue for every settings write, so two patches that overlap in time merge
// in order instead of racing: each one is computed against the state the one
// before it committed, rather than against the snapshot it started from. Disk
// stays the commit point — a failed write rejects to its own caller, commits
// nothing, and leaves the queue usable for whatever is behind it.
export function createSettingsWriter({ getCurrent, commit, save, codec }) {
  let queue = Promise.resolve()
  return (patch, prepare) => {
    const write = queue.then(async () => {
      const next = applySettingsUpdate(getCurrent(), patch, codec)
      const prepared = await prepare?.(next)
      try {
        await save(next)
      } catch (error) {
        await prepared?.rollback?.()
        throw error
      }
      commit(next)
      return next
    })
    // The chain itself must never carry a rejection forward, or one failed save
    // would poison every write after it.
    queue = write.then(() => {}, () => {})
    return write
  }
}

// Main-process only, and deliberately not wired to any IPC handler: this is
// what a later task hands to the backend spawn, never to a renderer.
export function readSecret(settings, key, codec) {
  if (!SECRET_KEY_SET.has(key)) return null
  const entry = normalizeSettings(settings).secrets[key]
  if (!entry) return null
  const raw = Buffer.from(entry.data, 'base64')
  if (entry.enc === 'none') return raw.toString('utf8')
  try {
    return codec.decrypt(raw)
  } catch {
    // A key sealed by another OS user, another machine, or a reset keychain:
    // treat it as absent so the caller re-prompts instead of crashing.
    return null
  }
}

/** `initialize` pins a first-launch language choice to disk; pass false where the settings file
 *  must stay untouched, such as the recovery-failed path that still offers the previous file. */
export async function loadSettings(file, systemLanguages, {initialize = true} = {}) {
  let raw
  let readable = true
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    readable = error?.code === 'ENOENT'
    raw = undefined
  }
  const settings = normalizeSettings(raw, {...DEFAULT_SETTINGS, language: systemLanguages ? preferredLanguage(systemLanguages) : DEFAULT_SETTINGS.language})
  if (initialize && systemLanguages && readable && !['zh-CN', 'en'].includes(raw?.language)) await saveSettings(file, settings)
  return settings
}

export async function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings)
  await saveJson(file, normalized)
  return normalized
}

async function saveJson(file, value) {
  await replaceFile(file, JSON.stringify(value))
}

async function replaceFile(file, bytes) {
  // Same-directory tmp + rename keeps a crash from truncating the live file;
  // the random suffix keeps two writers from colliding on one tmp name.
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

// Persist the sealed pre-transaction settings before either live file changes.
// A crash leaves this record pending; startup restores it before spawning.
export async function saveSettingsRecovery(file, settings, capability = null) {
  await saveJson(`${file}.recovery`, {version: 1, settings: normalizeSettings(settings), capability})
}

export async function restoreSettingsRecovery(file) {
  let recovery
  try { recovery = JSON.parse(await readFile(`${file}.recovery`, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (recovery?.version !== 1 || !isRecord(recovery.settings)) throw new Error('invalid settings recovery')
  const settings = normalizeSettings(recovery.settings)
  const capability = recovery.capability
  if (capability !== null) {
    if (!isRecord(capability) || typeof capability.path !== 'string' || !isAbsolute(capability.path)
      || [resolve(file), resolve(`${file}.recovery`)].includes(resolve(capability.path))
      || typeof capability.written !== 'string' || !BASE64.test(capability.written)
      || (capability.previous !== null && (typeof capability.previous !== 'string'
        || (capability.previous !== '' && !BASE64.test(capability.previous))))) throw new Error('invalid capability recovery')
    await restoreCapabilitySnapshot(capability)
  }
  await saveSettings(file, settings)
  // Keep the record until restored settings have activated successfully.
  return settings
}

export async function clearSettingsRecovery(file) {
  await unlink(`${file}.recovery`).catch(error => { if (error.code !== 'ENOENT') throw error })
}

// Accept only the transaction's bytes or the already-restored snapshot. A later
// external edit belongs to its writer, including a file created after rollback.
// ponytail: an external writer can race read/rename; shared CLI locking is needed for cross-process serialization.
export async function restoreCapabilitySnapshot({path, previous, written}) {
  let current = null
  try { current = (await readFile(path)).toString('base64') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current === previous) return
  if (current !== written) throw Object.assign(new Error('capability changed during settings recovery'), {code: 'settings_recovery_conflict'})
  if (previous === null) await unlink(path)
  else await replaceFile(path, Buffer.from(previous, 'base64'))
}
