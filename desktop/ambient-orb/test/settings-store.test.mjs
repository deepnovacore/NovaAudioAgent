import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  applySettingsUpdate,
  createSafeStorageCodec,
  createSettingsWriter,
  hasPlaintextSecret,
  loadSettings,
  normalizeSettings,
  publicSettings,
  readSecret,
  saveSettings,
  secretsPresent,
} from '../src/main/settings-store.mjs'

const ALL_SECRET_KEYS = Object.freeze([
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
])

// The store never imports Electron: the keychain arrives as this three-method
// codec, so every secrets path is exercised without a real safeStorage.
function fakeCodec({ available = true } = {}) {
  return {
    available: () => available,
    encrypt: plaintext => Buffer.from(`sealed:${plaintext}`, 'utf8'),
    decrypt: buffer => {
      const text = Buffer.from(buffer).toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('ciphertext is not ours')
      return text.slice(7)
    },
  }
}

// Stands in for Electron's `safeStorage` module, which the codec factory is the
// only thing in the repo to touch. `getSelectedStorageBackend` is added only
// when the test wants it, because older Electron does not have the method.
function fakeSafeStorage({ encryptionAvailable = true, backend } = {}) {
  const storage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: plaintext => Buffer.from(`sealed:${plaintext}`, 'utf8'),
    decryptString: buffer => Buffer.from(buffer).toString('utf8').slice(7),
  }
  if (backend !== undefined) storage.getSelectedStorageBackend = () => backend
  return storage
}

function plaintextEntry(value) {
  return { enc: 'none', data: Buffer.from(value, 'utf8').toString('base64') }
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'nova-orb-settings-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the default settings are the documented schema', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    version: 2,
    palette: 'ember',
    proactivity: 'balanced',
    codexHeartbeatSeconds: 30,
    pipelineMode: 'integrated',
    integratedProvider: 'qwen',
    integratedModel: 'qwen-audio-3.0-realtime-plus',
    integratedVoice: 'longanqian',
    cascadedEndpointingProvider: 'auto',
    cascadedAsrProvider: 'volcengine',
    cascadedLlmProvider: 'qwen',
    cascadedLlmModels: { qwen: 'qwen-flash', ark: 'doubao-seed-2-0-pro-260215' },
    cascadedTtsProvider: 'volcengine',
    cascadedTtsVoice: 'zh_female_vv_uranus_bigtts',
    secrets: {},
  })
  assert.deepEqual([...SECRET_KEYS], ALL_SECRET_KEYS)
})

test('normalizeSettings rebuilds defaults from nothing at all', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings('graphite'), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS)
})

test('normalizeSettings keeps valid fields and defaults each invalid one on its own', () => {
  const normalized = normalizeSettings({
    version: 99,
    palette: 'graphite',
    proactivity: 'reckless',
    codexHeartbeatSeconds: 45,
    pipelineMode: 'cascaded',
    integratedProvider: 'not-qwen',
    integratedModel: '  qwen-realtime-custom  ',
    integratedVoice: '  longxiaochun  ',
    cascadedEndpointingProvider: 'manual',
    cascadedAsrProvider: 'volcengine',
    cascadedLlmProvider: 'ark',
    cascadedLlmModels: {
      qwen: '  qwen-plus  ',
      ark: '  doubao-custom  ',
    },
    cascadedTtsProvider: 'not-volcengine',
    cascadedTtsVoice: '  zh_female_custom  ',
  })

  assert.deepEqual(normalized, {
    version: 2,
    palette: 'graphite',
    proactivity: 'balanced',
    codexHeartbeatSeconds: 45,
    pipelineMode: 'cascaded',
    integratedProvider: 'qwen',
    integratedModel: 'qwen-realtime-custom',
    integratedVoice: 'longxiaochun',
    cascadedEndpointingProvider: 'auto',
    cascadedAsrProvider: 'volcengine',
    cascadedLlmProvider: 'ark',
    cascadedLlmModels: { qwen: 'qwen-plus', ark: 'doubao-custom' },
    cascadedTtsProvider: 'volcengine',
    cascadedTtsVoice: 'zh_female_custom',
    secrets: {},
  })
})

test('normalizeSettings defaults every invalid v2 field independently', () => {
  const normalized = normalizeSettings({
    pipelineMode: 'parallel',
    integratedProvider: 'ark',
    integratedModel: '',
    integratedVoice: 'bad\nvoice',
    cascadedEndpointingProvider: null,
    cascadedAsrProvider: 'qwen',
    cascadedLlmProvider: 'openai',
    cascadedLlmModels: { qwen: '', ark: 'x'.repeat(65) },
    cascadedTtsProvider: 'qwen',
    cascadedTtsVoice: 42,
  })

  assert.equal(normalized.pipelineMode, DEFAULT_SETTINGS.pipelineMode)
  assert.equal(normalized.integratedProvider, DEFAULT_SETTINGS.integratedProvider)
  assert.equal(normalized.integratedModel, DEFAULT_SETTINGS.integratedModel)
  assert.equal(normalized.integratedVoice, DEFAULT_SETTINGS.integratedVoice)
  assert.equal(
    normalized.cascadedEndpointingProvider,
    DEFAULT_SETTINGS.cascadedEndpointingProvider,
  )
  assert.equal(normalized.cascadedAsrProvider, DEFAULT_SETTINGS.cascadedAsrProvider)
  assert.equal(normalized.cascadedLlmProvider, DEFAULT_SETTINGS.cascadedLlmProvider)
  assert.deepEqual(normalized.cascadedLlmModels, DEFAULT_SETTINGS.cascadedLlmModels)
  assert.equal(normalized.cascadedTtsProvider, DEFAULT_SETTINGS.cascadedTtsProvider)
  assert.equal(normalized.cascadedTtsVoice, DEFAULT_SETTINGS.cascadedTtsVoice)
})

test('normalizeSettings drops unknown keys instead of carrying them forward', () => {
  const normalized = normalizeSettings({
    palette: 'ember',
    __proto__polluted: true,
    endpoint: 'ws://127.0.0.1:1/',
    token: 'deadbeef',
  })

  assert.deepEqual(Object.keys(normalized).sort(), [
    'cascadedAsrProvider',
    'cascadedEndpointingProvider',
    'cascadedLlmModels',
    'cascadedLlmProvider',
    'cascadedTtsProvider',
    'cascadedTtsVoice',
    'codexHeartbeatSeconds',
    'integratedModel',
    'integratedProvider',
    'integratedVoice',
    'palette',
    'pipelineMode',
    'proactivity',
    'secrets',
    'version',
  ])
})

test('normalizeSettings reads only own enumerable top-level data properties', () => {
  let getterCalls = 0
  const inherited = {
    palette: 'graphite',
    proactivity: 'eager',
    integratedModel: 'inherited-model',
  }
  const raw = Object.create(inherited)
  Object.defineProperties(raw, {
    codexHeartbeatSeconds: { value: 45, enumerable: true },
    pipelineMode: {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'cascaded'
      },
    },
    integratedVoice: { value: 'hidden-voice', enumerable: false },
  })
  Object.defineProperty(raw, Symbol('hostile'), {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'symbol-value'
    },
  })

  const normalized = normalizeSettings(raw)

  assert.equal(getterCalls, 0)
  assert.equal(normalized.codexHeartbeatSeconds, 45)
  assert.equal(normalized.palette, 'ember')
  assert.equal(normalized.proactivity, 'balanced')
  assert.equal(normalized.pipelineMode, 'integrated')
  assert.equal(normalized.integratedModel, 'qwen-audio-3.0-realtime-plus')
  assert.equal(normalized.integratedVoice, 'longanqian')
})

test('normalizeSettings reads remembered models only from own enumerable data properties', () => {
  let getterCalls = 0
  const models = Object.create({ qwen: 'inherited-qwen' })
  Object.defineProperties(models, {
    ark: {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'getter-ark'
      },
    },
    qwenHidden: { value: 'hidden', enumerable: false },
  })
  Object.defineProperty(models, Symbol('hostile'), {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'symbol-model'
    },
  })

  const normalized = normalizeSettings({ cascadedLlmModels: models })

  assert.equal(getterCalls, 0)
  assert.deepEqual(normalized.cascadedLlmModels, {
    qwen: 'qwen-flash',
    ark: 'doubao-seed-2-0-pro-260215',
  })

  const partiallyHidden = {}
  Object.defineProperties(partiallyHidden, {
    qwen: { value: 'qwen-own', enumerable: true },
    ark: { value: 'ark-hidden', enumerable: false },
  })
  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: partiallyHidden,
  }).cascadedLlmModels, {
    qwen: 'qwen-own',
    ark: 'doubao-seed-2-0-pro-260215',
  })
})

test('normalizeSettings drops hostile secret maps and entries without invoking getters', () => {
  let getterCalls = 0
  const secrets = Object.create({
    dashscopeApiKey: { enc: 'none', data: 'aW5oZXJpdGVk' },
  })
  Object.defineProperties(secrets, {
    tavilyApiKey: {
      value: { enc: 'none', data: 'dGF2aWx5' },
      enumerable: true,
    },
    arkApiKey: {
      enumerable: true,
      get() {
        getterCalls += 1
        return { enc: 'none', data: 'YXJr' }
      },
    },
    codexApiKey: {
      value: { enc: 'none', data: 'Y29kZXg=' },
      enumerable: false,
    },
  })
  const hostileEntry = {}
  Object.defineProperties(hostileEntry, {
    enc: {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'none'
      },
    },
    data: { value: 'ZG91YmFv', enumerable: true },
  })
  Object.defineProperty(secrets, 'doubaoBigmodelApiKey', {
    value: hostileEntry,
    enumerable: true,
  })
  Object.defineProperty(secrets, Symbol('hostile'), {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'symbol-secret'
    },
  })

  const normalized = normalizeSettings({ secrets })

  assert.equal(getterCalls, 0)
  assert.deepEqual(normalized.secrets, {
    tavilyApiKey: { enc: 'none', data: 'dGF2aWx5' },
  })
})

test('normalizeSettings applies descriptor-only rules to caller-supplied base values', () => {
  let getterCalls = 0
  const base = Object.create({ pipelineMode: 'cascaded' })
  Object.defineProperties(base, {
    palette: { value: 'graphite', enumerable: true },
    integratedModel: {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'getter-model'
      },
    },
    integratedVoice: { value: 'hidden-voice', enumerable: false },
    cascadedLlmModels: {
      enumerable: true,
      value: Object.create({ qwen: 'inherited-qwen', ark: 'inherited-ark' }),
    },
  })

  const normalized = normalizeSettings({
    palette: 'invalid',
    integratedModel: '',
    integratedVoice: '',
    cascadedLlmModels: { qwen: '', ark: '' },
  }, base)

  assert.equal(getterCalls, 0)
  assert.equal(normalized.palette, 'graphite')
  assert.equal(normalized.pipelineMode, 'integrated')
  assert.equal(normalized.integratedModel, 'qwen-audio-3.0-realtime-plus')
  assert.equal(normalized.integratedVoice, 'longanqian')
  assert.deepEqual(normalized.cascadedLlmModels, {
    qwen: 'qwen-flash',
    ark: 'doubao-seed-2-0-pro-260215',
  })
})

test('normalizeSettings fails closed for descriptor-hostile and revoked proxy shapes', () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error('ordinary property read must never happen')
    },
    getOwnPropertyDescriptor() {
      throw new Error('descriptor unavailable')
    },
  })
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()

  assert.deepEqual(normalizeSettings(hostile), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings(revoked), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ cascadedLlmModels: hostile }), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ secrets: hostile }), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({}, hostile), DEFAULT_SETTINGS)
})

test('normalizeSettings rejects rather than clamps an out-of-range heartbeat', () => {
  assert.equal(normalizeSettings({ codexHeartbeatSeconds: 15 }).codexHeartbeatSeconds, 15)
  assert.equal(normalizeSettings({ codexHeartbeatSeconds: 120 }).codexHeartbeatSeconds, 120)
  for (const bad of [14, 121, 30.5, '30', Number.NaN, null, Infinity]) {
    assert.equal(
      normalizeSettings({ codexHeartbeatSeconds: bad }).codexHeartbeatSeconds,
      30,
      `heartbeat ${String(bad)} falls back to the default`,
    )
  }
})

test('normalizeSettings bounds every model and voice string and refuses control characters', () => {
  for (const field of ['integratedModel', 'integratedVoice', 'cascadedTtsVoice']) {
    assert.equal(normalizeSettings({ [field]: '  custom-value  ' })[field], 'custom-value')
    assert.equal(normalizeSettings({ [field]: 'x'.repeat(64) })[field], 'x'.repeat(64))
    assert.equal(normalizeSettings({ [field]: '😀'.repeat(64) })[field], '😀'.repeat(64))
    for (const bad of ['', '   ', 'x'.repeat(65), '😀'.repeat(65), 'bad\nvalue', 42]) {
      assert.equal(normalizeSettings({ [field]: bad })[field], DEFAULT_SETTINGS[field])
    }
  }
})

test('normalizeSettings rejects leading and trailing controls before trimming model and voice values', () => {
  for (const field of ['integratedModel', 'integratedVoice', 'cascadedTtsVoice']) {
    for (const bad of ['\nvalid-value', 'valid-value\r', '\tvalid-value', 'valid-value\u007f']) {
      assert.equal(
        normalizeSettings({ [field]: bad })[field],
        DEFAULT_SETTINGS[field],
        `${field} rejects ${JSON.stringify(bad)} from the raw input`,
      )
    }
  }

  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: { qwen: '\nqwen-custom', ark: 'ark-valid' },
  }).cascadedLlmModels, {
    qwen: 'qwen-flash',
    ark: 'ark-valid',
  })
  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: { qwen: 'qwen-valid', ark: 'ark-custom\r' },
  }).cascadedLlmModels, {
    qwen: 'qwen-valid',
    ark: 'doubao-seed-2-0-pro-260215',
  })
})

test('normalizeSettings treats cascadedLlmModels as a strict independent two-provider map', () => {
  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: { qwen: 'qwen-max', ark: 'ark-custom', extra: 'drop-me' },
  }).cascadedLlmModels, { qwen: 'qwen-max', ark: 'ark-custom' })

  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: { qwen: 'qwen-max' },
  }).cascadedLlmModels, {
    qwen: 'qwen-max',
    ark: DEFAULT_SETTINGS.cascadedLlmModels.ark,
  })
  assert.deepEqual(normalizeSettings({
    cascadedLlmModels: { qwen: 'bad\nmodel', ark: 'ark-custom' },
  }).cascadedLlmModels, {
    qwen: DEFAULT_SETTINGS.cascadedLlmModels.qwen,
    ark: 'ark-custom',
  })
  for (const bad of [null, [], 'qwen-flash']) {
    assert.deepEqual(normalizeSettings({ cascadedLlmModels: bad }).cascadedLlmModels, {
      ...DEFAULT_SETTINGS.cascadedLlmModels,
    })
  }
})

test('normalizeSettings falls back per field to a caller-supplied base', () => {
  const base = normalizeSettings({
    palette: 'graphite',
    proactivity: 'eager',
    codexHeartbeatSeconds: 90,
    pipelineMode: 'cascaded',
    integratedModel: 'integrated-kept',
    cascadedLlmProvider: 'ark',
    cascadedLlmModels: { qwen: 'qwen-kept', ark: 'ark-kept' },
  })
  const merged = normalizeSettings({
    palette: 'ember',
    proactivity: 'nonsense',
    integratedModel: '',
    cascadedLlmModels: { qwen: 'qwen-next', ark: '' },
  }, base)

  assert.equal(merged.palette, 'ember')
  assert.equal(merged.proactivity, 'eager')
  assert.equal(merged.codexHeartbeatSeconds, 90)
  assert.equal(merged.pipelineMode, 'cascaded')
  assert.equal(merged.integratedModel, 'integrated-kept')
  assert.equal(merged.cascadedLlmProvider, 'ark')
  assert.deepEqual(merged.cascadedLlmModels, { qwen: 'qwen-next', ark: 'ark-kept' })
})

test('normalizeSettings keeps only well-formed secret entries', () => {
  const normalized = normalizeSettings({
    secrets: {
      dashscopeApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' },
      tavilyApiKey: { enc: 'none', data: 'aGk=' },
      modelApiKey: { enc: 'rot13', data: 'aGk=' },
      codexApiKey: { enc: 'none', data: 'not base64!' },
      arkApiKey: { enc: 'safeStorage', data: 'YXJr' },
      doubaoBigmodelApiKey: { enc: 'none', data: 'ZG91YmFv' },
      doubaoAsrApiKey: { enc: 'safeStorage', data: 'YXNy' },
      strayKey: { enc: 'none', data: 'aGk=' },
    },
  })

  assert.deepEqual(normalized.secrets, {
    dashscopeApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' },
    tavilyApiKey: { enc: 'none', data: 'aGk=' },
    arkApiKey: { enc: 'safeStorage', data: 'YXJr' },
    doubaoBigmodelApiKey: { enc: 'none', data: 'ZG91YmFv' },
    doubaoAsrApiKey: { enc: 'safeStorage', data: 'YXNy' },
  })
})

test('normalizeSettings rejects secret entries that are not objects or lack data', () => {
  const normalized = normalizeSettings({
    secrets: {
      dashscopeApiKey: 'plaintext-would-be-a-bug',
      tavilyApiKey: { enc: 'none' },
      modelApiKey: { enc: 'none', data: '' },
      codexApiKey: null,
      arkApiKey: [],
      doubaoBigmodelApiKey: { enc: 'none', data: 'not base64!' },
      doubaoAsrApiKey: { enc: 'rot13', data: 'YXNy' },
    },
  })

  assert.deepEqual(normalized.secrets, {})
})

test('publicSettings never carries the secrets object', () => {
  const settings = applySettingsUpdate(
    DEFAULT_SETTINGS,
    { secrets: { dashscopeApiKey: 'sk-visible' } },
    fakeCodec(),
  )
  const view = publicSettings(settings)

  assert.deepEqual(Object.keys(view).sort(), [
    'cascadedAsrProvider',
    'cascadedEndpointingProvider',
    'cascadedLlmModels',
    'cascadedLlmProvider',
    'cascadedTtsProvider',
    'cascadedTtsVoice',
    'codexHeartbeatSeconds',
    'integratedModel',
    'integratedProvider',
    'integratedVoice',
    'palette',
    'pipelineMode',
    'proactivity',
    'version',
  ])
  assert.doesNotMatch(JSON.stringify(view), /sk-visible|sealed/)
})

test('secretsPresent reports booleans for every key and leaks no ciphertext', () => {
  const settings = applySettingsUpdate(
    DEFAULT_SETTINGS,
    { secrets: { dashscopeApiKey: 'sk-dash', codexApiKey: 'sk-codex' } },
    fakeCodec(),
  )

  assert.deepEqual(secretsPresent(settings), {
    dashscopeApiKey: true,
    tavilyApiKey: false,
    modelApiKey: false,
    codexApiKey: true,
    arkApiKey: false,
    doubaoBigmodelApiKey: false,
    doubaoAsrApiKey: false,
  })
  assert.doesNotMatch(JSON.stringify(secretsPresent(settings)), /sk-dash|sk-codex|sealed/)
  assert.deepEqual(secretsPresent(undefined), {
    dashscopeApiKey: false,
    tavilyApiKey: false,
    modelApiKey: false,
    codexApiKey: false,
    arkApiKey: false,
    doubaoBigmodelApiKey: false,
    doubaoAsrApiKey: false,
  })
})

test('all seven secret fields seal, report presence, round-trip, and clear independently', () => {
  const codec = fakeCodec()
  const values = Object.fromEntries(ALL_SECRET_KEYS.map(key => [key, `${key}-value`]))
  const stored = applySettingsUpdate(DEFAULT_SETTINGS, { secrets: values }, codec)

  assert.deepEqual(secretsPresent(stored), Object.fromEntries(ALL_SECRET_KEYS.map(key => [key, true])))
  for (const key of ALL_SECRET_KEYS) {
    assert.equal(stored.secrets[key].enc, 'safeStorage')
    assert.equal(readSecret(stored, key, codec), `${key}-value`)
  }

  const cleared = applySettingsUpdate(
    stored,
    { secrets: Object.fromEntries(ALL_SECRET_KEYS.map(key => [key, ''])) },
    codec,
  )
  assert.deepEqual(cleared.secrets, {})
  assert.deepEqual(secretsPresent(cleared), Object.fromEntries(ALL_SECRET_KEYS.map(key => [key, false])))
})

test('applySettingsUpdate seals plaintext through the codec and round-trips it back', () => {
  const codec = fakeCodec()
  const updated = applySettingsUpdate(DEFAULT_SETTINGS, {
    palette: 'graphite',
    secrets: { tavilyApiKey: 'tvly-secret' },
  }, codec)

  assert.equal(updated.palette, 'graphite')
  assert.equal(updated.secrets.tavilyApiKey.enc, 'safeStorage')
  assert.equal(
    Buffer.from(updated.secrets.tavilyApiKey.data, 'base64').toString('utf8'),
    'sealed:tvly-secret',
  )
  assert.equal(readSecret(updated, 'tavilyApiKey', codec), 'tvly-secret')
  assert.equal(readSecret(updated, 'modelApiKey', codec), null)
})

test('applySettingsUpdate falls back to enc:none when no keyring is available', () => {
  const codec = fakeCodec({ available: false })
  const updated = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { modelApiKey: 'sk-plain' },
  }, codec)

  assert.deepEqual(updated.secrets.modelApiKey, {
    enc: 'none',
    data: Buffer.from('sk-plain', 'utf8').toString('base64'),
  })
  assert.equal(readSecret(updated, 'modelApiKey', codec), 'sk-plain')
})

test('the safeStorage codec refuses linux basic_text, which is not protected storage', () => {
  // `isEncryptionAvailable()` answers true for the basic_text backend too, but
  // that backend encrypts with a hardcoded password: the file is readable by
  // anyone, so the store must treat it exactly like "no keyring at all".
  const basicText = createSafeStorageCodec(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
  const keyring = createSafeStorageCodec(fakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux')
  const older = createSafeStorageCodec(fakeSafeStorage(), 'linux')
  const macos = createSafeStorageCodec(fakeSafeStorage(), 'darwin')
  const windows = createSafeStorageCodec(fakeSafeStorage(), 'win32')
  const noKeyring = createSafeStorageCodec(
    fakeSafeStorage({ encryptionAvailable: false, backend: 'kwallet6' }),
    'linux',
  )
  const throwing = createSafeStorageCodec({
    isEncryptionAvailable: () => {
      throw new Error('no dbus session')
    },
  }, 'linux')

  assert.equal(basicText.available(), false, 'basic_text is a hardcoded password, not protection')
  assert.equal(keyring.available(), true, 'a real linux keyring backend still counts')
  assert.equal(
    older.available(),
    false,
    'an Electron without getSelectedStorageBackend cannot prove protection on linux',
  )
  assert.equal(macos.available(), true, 'only linux has the basic_text fallback')
  assert.equal(windows.available(), true)
  assert.equal(noKeyring.available(), false)
  assert.equal(throwing.available(), false, 'a throwing safeStorage is unavailable, not a crash')
})

test('a secret saved under linux basic_text is stored as plaintext and says so', () => {
  const codec = createSafeStorageCodec(fakeSafeStorage({ backend: 'basic_text' }), 'linux')
  const updated = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { modelApiKey: 'sk-linux' },
  }, codec)

  assert.equal(updated.secrets.modelApiKey.enc, 'none')
  assert.equal(hasPlaintextSecret(updated), true, 'the panel warning must be on')
  assert.equal(readSecret(updated, 'modelApiKey', codec), 'sk-linux')
})

test('hasPlaintextSecret answers for what is stored, not for the codec of the moment', () => {
  const stale = normalizeSettings({
    secrets: {
      dashscopeApiKey: plaintextEntry('sk-stale'),
      codexApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' },
    },
  })
  const sealed = normalizeSettings({
    secrets: { codexApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' } },
  })

  // The keyring is available now, but this entry was written before it was:
  // the file is still plaintext-equivalent, so the warning must persist.
  assert.equal(hasPlaintextSecret(stale), true)
  assert.equal(hasPlaintextSecret(sealed), false)
  assert.equal(hasPlaintextSecret(DEFAULT_SETTINGS), false)
  assert.equal(hasPlaintextSecret(undefined), false)
})

test('any update re-seals the secrets a vanished keyring left in plaintext', () => {
  const codec = fakeCodec()
  const encrypted = []
  const observing = {
    available: codec.available,
    encrypt: plaintext => {
      encrypted.push(plaintext)
      return codec.encrypt(plaintext)
    },
    decrypt: codec.decrypt,
  }
  const stored = normalizeSettings({
    secrets: {
      dashscopeApiKey: plaintextEntry('sk-stale'),
      codexApiKey: { enc: 'safeStorage', data: Buffer.from('sealed:sk-fresh').toString('base64') },
    },
  })

  const migrated = applySettingsUpdate(stored, { palette: 'graphite' }, observing)

  assert.equal(migrated.palette, 'graphite')
  assert.equal(migrated.secrets.dashscopeApiKey.enc, 'safeStorage')
  assert.equal(readSecret(migrated, 'dashscopeApiKey', observing), 'sk-stale')
  assert.deepEqual(encrypted, ['sk-stale'], 'only the plaintext entry is re-sealed')
  assert.deepEqual(
    migrated.secrets.codexApiKey,
    stored.secrets.codexApiKey,
    'an already-sealed entry is not re-encrypted',
  )
  assert.equal(hasPlaintextSecret(migrated), false)
})

test('no keyring means no migration: a plaintext entry is left exactly as it was', () => {
  const stored = normalizeSettings({ secrets: { tavilyApiKey: plaintextEntry('tvly-stale') } })

  const updated = applySettingsUpdate(stored, { palette: 'graphite' }, fakeCodec({ available: false }))

  assert.deepEqual(updated.secrets.tavilyApiKey, stored.secrets.tavilyApiKey)
  assert.equal(hasPlaintextSecret(updated), true)
})

test('a re-seal that throws leaves that one entry untouched rather than losing it', () => {
  const codec = fakeCodec()
  const partial = {
    available: codec.available,
    encrypt: plaintext => {
      if (plaintext === 'sk-doomed') throw new Error('keyring went away mid-write')
      return codec.encrypt(plaintext)
    },
    decrypt: codec.decrypt,
  }
  const stored = normalizeSettings({
    secrets: {
      dashscopeApiKey: plaintextEntry('sk-doomed'),
      tavilyApiKey: plaintextEntry('sk-ok'),
    },
  })

  const migrated = applySettingsUpdate(stored, { palette: 'graphite' }, partial)

  assert.deepEqual(
    migrated.secrets.dashscopeApiKey,
    stored.secrets.dashscopeApiKey,
    'a failed re-seal is a no-op, never a dropped key',
  )
  assert.equal(readSecret(migrated, 'dashscopeApiKey', partial), 'sk-doomed')
  assert.equal(migrated.secrets.tavilyApiKey.enc, 'safeStorage', 'the other entry still migrates')
  assert.equal(migrated.palette, 'graphite')
})

test('an oversized re-seal leaves a boundary-valid plaintext entry intact', () => {
  const plaintext = '密'.repeat(2048)
  const stored = normalizeSettings({
    secrets: { arkApiKey: plaintextEntry(plaintext) },
  })

  const migrated = applySettingsUpdate(stored, { palette: 'graphite' }, fakeCodec())

  assert.deepEqual(migrated.secrets.arkApiKey, stored.secrets.arkApiKey)
  assert.deepEqual(normalizeSettings(migrated).secrets.arkApiKey, stored.secrets.arkApiKey)
  assert.equal(readSecret(migrated, 'arkApiKey', fakeCodec()), plaintext)
  assert.equal(migrated.palette, 'graphite')
  assert.deepEqual(migrated.rejectedSecrets, [])
})

test('a secret carrying a NUL or other control character is refused, not stored', () => {
  const codec = fakeCodec()
  const stored = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { dashscopeApiKey: 'sk-good' },
  }, codec)

  // A NUL in an env value makes Node refuse the spawn outright, so a secret
  // that contains one would brick the next launch. The field is rejected on
  // its own; everything else in the same patch still lands.
  const patched = applySettingsUpdate(stored, {
    palette: 'graphite',
    secrets: { dashscopeApiKey: 'sk-\u0000poison', tavilyApiKey: 'tvly-fine' },
  }, codec)

  assert.deepEqual(patched.secrets.dashscopeApiKey, stored.secrets.dashscopeApiKey)
  assert.equal(readSecret(patched, 'tavilyApiKey', codec), 'tvly-fine')
  assert.equal(patched.palette, 'graphite')
  // The poisoned field is named, by key only, so a caller can tell the
  // renderer which paste failed instead of the save looking like a silent,
  // total success.
  assert.deepEqual(patched.rejectedSecrets, ['dashscopeApiKey'])
  for (const bad of ['\u0000', 'sk-\u0000x', 'sk-\u001bx', 'sk\nx', 'sk\tx', 'sk\u007fx']) {
    const attempt = applySettingsUpdate(DEFAULT_SETTINGS, { secrets: { modelApiKey: bad } }, codec)
    assert.deepEqual(attempt.secrets, {}, `${JSON.stringify(bad)} never reaches the store`)
    assert.deepEqual(attempt.rejectedSecrets, ['modelApiKey'], `${JSON.stringify(bad)} is named as rejected`)
  }
})

test('a sealed secret too large for the stored schema is rejected without replacing the key', () => {
  const stored = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { arkApiKey: 'ark-existing' },
  }, fakeCodec())
  const oversizedAfterUtf8Encoding = '密'.repeat(2100)

  const patched = applySettingsUpdate(stored, {
    secrets: { arkApiKey: oversizedAfterUtf8Encoding },
  }, fakeCodec({ available: false }))

  assert.deepEqual(patched.secrets.arkApiKey, stored.secrets.arkApiKey)
  assert.deepEqual(patched.rejectedSecrets, ['arkApiKey'])
  assert.equal(readSecret(patched, 'arkApiKey', fakeCodec()), 'ark-existing')
})

test('readSecret returns null instead of throwing when the ciphertext no longer decrypts', () => {
  const stored = normalizeSettings({
    secrets: { codexApiKey: { enc: 'safeStorage', data: 'bm90LW91cnM=' } },
  })

  assert.equal(readSecret(stored, 'codexApiKey', fakeCodec()), null)
  assert.equal(readSecret(stored, 'strayKey', fakeCodec()), null)
})

// Companion to main-security.test.mjs's source-text scan for
// `console.*` lines naming a secret: that scan keys on identifier
// substrings ("plaintext", "secret", "apiKey") in main.mjs's source, so a
// rename of any of those locals would defeat it silently without this test
// noticing. This test instead runs the *real* decrypt path (readSecret,
// which is what main.mjs's decryptSecretsForSpawn calls before logging on
// failure) end to end with a distinctive runtime marker and inspects the
// actual captured log text for that marker's content — a check that holds
// regardless of what any variable in the source is named.
test('a decrypt failure never lets the plaintext reach the console, only the key name', () => {
  const MARKER = 'MARKER-SECRET-DO-NOT-LOG'
  const sealingCodec = fakeCodec()
  const sealed = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { codexApiKey: MARKER },
  }, sealingCodec)

  // Worst case, not just the happy path: the codec that fails to decrypt
  // throws an error whose *message* itself echoes the marker, the way a
  // buggy or overly chatty crypto library might embed input context in its
  // diagnostics. readSecret's catch block must discard the thrown error
  // entirely rather than forwarding any part of it.
  const hostileCodec = {
    available: () => true,
    encrypt: sealingCodec.encrypt,
    decrypt: () => {
      throw new Error(`decrypt failed while handling ${MARKER}`)
    },
  }

  const calls = []
  const mockConsole = { error: (...args) => calls.push(args.join(' ')) }

  // Mirrors main.mjs's decryptSecretsForSpawn (src/main/main.mjs, just above
  // `launchBackend`): decrypt via readSecret, and on any non-string/empty
  // result, log the key name only via the exact
  // `settings_secret_unreadable key=${key}` diagnostic — never the value.
  const key = 'codexApiKey'
  const plaintext = readSecret(sealed, key, hostileCodec)
  if (typeof plaintext === 'string' && plaintext) {
    mockConsole.error(`[test-leak-canary] ${plaintext}`)
  } else {
    mockConsole.error(`[desktop-diagnostic] settings_secret_unreadable key=${key}`)
  }

  assert.equal(plaintext, null)
  const logged = calls.join('\n')
  assert.doesNotMatch(logged, new RegExp(MARKER), 'the marker plaintext leaked into a log line')
  assert.match(logged, /key=codexApiKey/, 'the diagnostic must still name the unreadable key')
})

test('applySettingsUpdate clears a stored key on an empty string and ignores the rest', () => {
  const codec = fakeCodec()
  const stored = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { dashscopeApiKey: 'sk-dash', codexApiKey: 'sk-codex' },
  }, codec)
  const cleared = applySettingsUpdate(stored, {
    secrets: { dashscopeApiKey: '', tavilyApiKey: undefined, strayKey: 'sk-stray' },
  }, codec)

  assert.equal(cleared.secrets.dashscopeApiKey, undefined)
  assert.equal(cleared.secrets.codexApiKey.enc, 'safeStorage')
  assert.equal(cleared.secrets.strayKey, undefined)
  assert.deepEqual(Object.keys(cleared.secrets), ['codexApiKey'])
})

test('applySettingsUpdate keeps unspecified fields and refuses malformed secret values', () => {
  const codec = fakeCodec()
  const stored = applySettingsUpdate(DEFAULT_SETTINGS, {
    palette: 'graphite',
    proactivity: 'eager',
    codexHeartbeatSeconds: 75,
    integratedVoice: 'longcheng',
    cascadedTtsVoice: 'zh_female_kept',
  }, codec)
  const updated = applySettingsUpdate(stored, {
    codexHeartbeatSeconds: 9000,
    secrets: { dashscopeApiKey: 12345, tavilyApiKey: 'x'.repeat(4097) },
  }, codec)

  assert.equal(updated.palette, 'graphite')
  assert.equal(updated.proactivity, 'eager')
  assert.equal(updated.codexHeartbeatSeconds, 75, 'an out-of-range patch keeps the stored value')
  assert.equal(updated.integratedVoice, 'longcheng')
  assert.equal(updated.cascadedTtsVoice, 'zh_female_kept')
  assert.deepEqual(updated.secrets, {})
  // Both a wrong-typed value and an over-length one are named as rejected,
  // not just refused silently.
  assert.deepEqual(updated.rejectedSecrets, ['dashscopeApiKey', 'tavilyApiKey'])
})

test('a patch cannot smuggle in a pre-sealed secret entry', () => {
  // Only plaintext strings are accepted on the update path, so a renderer
  // cannot choose its own ciphertext or downgrade an entry to enc:'none'.
  const codec = fakeCodec()
  const updated = applySettingsUpdate(DEFAULT_SETTINGS, {
    secrets: { dashscopeApiKey: { enc: 'none', data: 'aGk=' } },
  }, codec)

  assert.deepEqual(updated.secrets, {})
})

test('applySettingsUpdate tolerates a missing or non-object patch', () => {
  const codec = fakeCodec()
  assert.deepEqual(
    applySettingsUpdate(DEFAULT_SETTINGS, undefined, codec),
    { ...DEFAULT_SETTINGS, rejectedSecrets: [] },
  )
  assert.deepEqual(
    applySettingsUpdate(DEFAULT_SETTINGS, 'palette', codec),
    { ...DEFAULT_SETTINGS, rejectedSecrets: [] },
  )
})

test('loadSettings answers defaults for a missing or corrupt file', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS)
    await writeFile(file, '{broken', 'utf8')
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS)
    await writeFile(file, '[]', 'utf8')
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS)
  })
})

test('saveSettings round-trips through loadSettings and leaves no temporary behind', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')
    const settings = applySettingsUpdate(DEFAULT_SETTINGS, {
      palette: 'graphite',
      proactivity: 'conservative',
      codexHeartbeatSeconds: 60,
      integratedVoice: 'longcheng',
      cascadedTtsVoice: 'zh_female_custom',
      secrets: { dashscopeApiKey: 'sk-round-trip' },
    }, fakeCodec())

    await saveSettings(file, settings)

    // `rejectedSecrets` rides on the applySettingsUpdate result as an extra,
    // additive field for this call only; it is never part of the persisted
    // schema, so it must not survive the round trip either.
    const { rejectedSecrets: _rejectedSecrets, ...persisted } = settings
    assert.deepEqual(await loadSettings(file), persisted)
    assert.deepEqual(await readdir(directory), ['ambient-orb-settings.json'])
  })
})

test('saveSettings writes owner-only and never spells a secret in plaintext', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')
    const settings = applySettingsUpdate(DEFAULT_SETTINGS, {
      secrets: { codexApiKey: 'sk-never-on-disk' },
    }, fakeCodec())

    await saveSettings(file, settings)

    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const body = await readFile(file, 'utf8')
    assert.doesNotMatch(body, /sk-never-on-disk/)
    assert.match(body, /"enc":"safeStorage"/)
  })
})

test('saveSettings normalizes before writing so junk can never reach disk', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')

    await saveSettings(file, { palette: 'neon', codexHeartbeatSeconds: 5, stray: 'x' })

    const body = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(body, DEFAULT_SETTINGS)
  })
})

test('the next save rewrites a plaintext entry on disk as ciphertext', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')
    await saveSettings(file, { secrets: { modelApiKey: plaintextEntry('sk-stale') } })

    // An unrelated field changes; the stale entry rides along with that write,
    // so the migration is atomic with the save rather than a separate rewrite.
    await saveSettings(file, applySettingsUpdate(
      await loadSettings(file),
      { integratedVoice: 'longcheng' },
      fakeCodec(),
    ))

    const body = await readFile(file, 'utf8')
    assert.doesNotMatch(body, /"enc":"none"/)
    assert.match(body, /"enc":"safeStorage"/)
    assert.doesNotMatch(
      body,
      new RegExp(plaintextEntry('sk-stale').data),
      'the plaintext-equivalent base64 is gone from the file',
    )
    const reloaded = await loadSettings(file)
    assert.equal(reloaded.integratedVoice, 'longcheng')
    assert.equal(readSecret(reloaded, 'modelApiKey', fakeCodec()), 'sk-stale')
  })
})

test('a rejected secret leaves the file byte-for-byte as it was for that key', async () => {
  await withTempDirectory(async directory => {
    const file = join(directory, 'ambient-orb-settings.json')
    const codec = fakeCodec()
    await saveSettings(file, applySettingsUpdate(DEFAULT_SETTINGS, {
      secrets: { codexApiKey: 'sk-good' },
    }, codec))
    const before = await readFile(file, 'utf8')

    const patched = applySettingsUpdate(
      await loadSettings(file),
      { secrets: { codexApiKey: 'sk-\u0000bad' } },
      codec,
    )
    await saveSettings(file, patched)

    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal(readSecret(await loadSettings(file), 'codexApiKey', codec), 'sk-good')
    assert.deepEqual(patched.rejectedSecrets, ['codexApiKey'], 'the caller can see which key failed')
  })
})

test('the settings writer serializes overlapping saves against the latest state', async () => {
  const codec = fakeCodec()
  let current = DEFAULT_SETTINGS
  const writes = []
  let second = null
  const writer = createSettingsWriter({
    codec,
    getCurrent: () => current,
    commit: next => {
      current = next
    },
    save: async next => {
      writes.push(next)
      // The second patch arrives while the first write is still in flight —
      // exactly the race. Without a queue it snapshots the pre-first state and
      // the palette change is lost when the second write commits.
      if (writes.length === 1) second = writer({ integratedVoice: 'longcheng' })
      await Promise.resolve()
      await Promise.resolve()
      return next
    },
  })

  const first = await writer({ palette: 'graphite' })
  const merged = await second

  assert.equal(first.palette, 'graphite')
  assert.equal(merged.palette, 'graphite', 'the second patch merged onto the committed first')
  assert.equal(merged.integratedVoice, 'longcheng')
  assert.equal(current.palette, 'graphite')
  assert.equal(current.integratedVoice, 'longcheng')
  assert.equal(writes.length, 2, 'both patches reached disk')
})

test('the settings writer neither commits nor stalls when one save fails', async () => {
  let current = DEFAULT_SETTINGS
  let failNext = true
  const writer = createSettingsWriter({
    codec: fakeCodec(),
    getCurrent: () => current,
    commit: next => {
      current = next
    },
    save: async next => {
      if (failNext) {
        failNext = false
        throw new Error('EACCES')
      }
      return next
    },
  })

  await assert.rejects(writer({ palette: 'graphite' }), /EACCES/)
  assert.equal(current.palette, 'ember', 'disk is the commit point, so nothing changed')

  const after = await writer({ palette: 'graphite' })

  assert.equal(after.palette, 'graphite', 'the queue survives a rejected write')
  assert.equal(current.palette, 'graphite')
})
