import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

// One schema version so far; `normalizeSettings` always stamps it, which is what
// makes a future migration a change in exactly one place.
export const SETTINGS_VERSION = 1

export const SECRET_KEYS = Object.freeze([
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
])

export const PALETTES = Object.freeze(['ember', 'graphite'])
export const PROACTIVITY_LEVELS = Object.freeze(['conservative', 'balanced', 'eager'])
export const HEARTBEAT_MIN_SECONDS = 15
export const HEARTBEAT_MAX_SECONDS = 120
export const MAX_VOICE_LENGTH = 64
// A key is a token, not a document: anything longer is a paste accident or an
// attempt to grow the settings file, and is refused rather than stored.
export const MAX_SECRET_LENGTH = 4096
const MAX_CIPHERTEXT_BASE64 = 8192

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  palette: 'ember',
  proactivity: 'balanced',
  codexHeartbeatSeconds: 30,
  voice: 'longanqian',
  secrets: Object.freeze({}),
})

const PALETTE_SET = new Set(PALETTES)
const PROACTIVITY_SET = new Set(PROACTIVITY_LEVELS)
const SECRET_KEY_SET = new Set(SECRET_KEYS)
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
// Control characters would survive into an env value handed to a child process.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

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

function validVoice(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || [...trimmed].length > MAX_VOICE_LENGTH) return null
  if (CONTROL_CHARACTERS.test(trimmed)) return null
  return trimmed
}

// Stored form only: `{enc, data}` where data is base64 ciphertext. Plaintext
// never has this shape, so a plaintext value that somehow reached the file is
// dropped rather than round-tripped.
function validSecretEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (entry.enc !== 'safeStorage' && entry.enc !== 'none') return null
  const { data } = entry
  if (typeof data !== 'string' || data === '' || data.length > MAX_CIPHERTEXT_BASE64) return null
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null
  return { enc: entry.enc, data }
}

function normalizeSecrets(raw) {
  const secrets = {}
  if (!raw || typeof raw !== 'object') return secrets
  for (const key of SECRET_KEYS) {
    const entry = validSecretEntry(raw[key])
    if (entry) secrets[key] = entry
  }
  return secrets
}

// Rebuilds the object rather than editing it: unknown keys have no path
// into the result, whatever the file on disk happens to contain.
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const fallback = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_SETTINGS
  return {
    version: SETTINGS_VERSION,
    palette: pick(source.palette, fallback.palette, DEFAULT_SETTINGS.palette, validPalette),
    proactivity: pick(
      source.proactivity,
      fallback.proactivity,
      DEFAULT_SETTINGS.proactivity,
      validProactivity,
    ),
    codexHeartbeatSeconds: pick(
      source.codexHeartbeatSeconds,
      fallback.codexHeartbeatSeconds,
      DEFAULT_SETTINGS.codexHeartbeatSeconds,
      validHeartbeat,
    ),
    voice: pick(source.voice, fallback.voice, DEFAULT_SETTINGS.voice, validVoice),
    secrets: normalizeSecrets(source.secrets),
  }
}

// The renderer's whole view of the settings: no secrets object, not even an
// empty one, so no future edit can widen it by accident.
export function publicSettings(settings) {
  const normalized = normalizeSettings(settings)
  return {
    version: normalized.version,
    palette: normalized.palette,
    proactivity: normalized.proactivity,
    codexHeartbeatSeconds: normalized.codexHeartbeatSeconds,
    voice: normalized.voice,
  }
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
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { secrets, rejected }
  for (const key of SECRET_KEYS) {
    if (!Object.hasOwn(updates, key)) continue
    const value = updates[key]
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
    secrets[key] = sealSecret(value, codec)
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
      migrated[key] = sealSecret(Buffer.from(entry.data, 'base64').toString('utf8'), codec)
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
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const next = normalizeSettings({
    palette: source.palette,
    proactivity: source.proactivity,
    codexHeartbeatSeconds: source.codexHeartbeatSeconds,
    voice: source.voice,
  }, stored)
  const { secrets, rejected } = updatedSecrets(stored.secrets, source.secrets, codec)
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
  return patch => {
    const write = queue.then(async () => {
      const next = applySettingsUpdate(getCurrent(), patch, codec)
      await save(next)
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

export async function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return normalizeSettings(undefined)
  }
}

export async function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings)
  // Same-directory tmp + rename keeps a crash from truncating the live file;
  // the random suffix keeps two writers from colliding on one tmp name.
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return normalized
}
