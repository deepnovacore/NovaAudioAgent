import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SETTINGS,
  SECRET_KEYS,
  applySettingsUpdate,
  loadSettings,
  normalizeSettings,
  publicSettings,
  readSecret,
  saveSettings,
  secretsPresent,
} from '../src/main/settings-store.mjs'

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
    version: 1,
    palette: 'ember',
    proactivity: 'balanced',
    codexHeartbeatSeconds: 30,
    voice: 'longanqian',
    secrets: {},
  })
  assert.deepEqual([...SECRET_KEYS], [
    'dashscopeApiKey',
    'tavilyApiKey',
    'modelApiKey',
    'codexApiKey',
  ])
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
    voice: '  longxiaochun  ',
  })

  assert.deepEqual(normalized, {
    version: 1,
    palette: 'graphite',
    proactivity: 'balanced',
    codexHeartbeatSeconds: 45,
    voice: 'longxiaochun',
    secrets: {},
  })
})

test('normalizeSettings drops unknown keys instead of carrying them forward', () => {
  const normalized = normalizeSettings({
    palette: 'ember',
    __proto__polluted: true,
    endpoint: 'ws://127.0.0.1:1/',
    token: 'deadbeef',
  })

  assert.deepEqual(Object.keys(normalized).sort(), [
    'codexHeartbeatSeconds',
    'palette',
    'proactivity',
    'secrets',
    'version',
    'voice',
  ])
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

test('normalizeSettings bounds the voice name and refuses control characters', () => {
  assert.equal(normalizeSettings({ voice: 'longcheng' }).voice, 'longcheng')
  assert.equal(normalizeSettings({ voice: '   ' }).voice, 'longanqian')
  assert.equal(normalizeSettings({ voice: 'x'.repeat(65) }).voice, 'longanqian')
  assert.equal(normalizeSettings({ voice: 'long\nanqian' }).voice, 'longanqian')
  assert.equal(normalizeSettings({ voice: 42 }).voice, 'longanqian')
  assert.equal(normalizeSettings({ voice: 'x'.repeat(64) }).voice, 'x'.repeat(64))
})

test('normalizeSettings falls back per field to a caller-supplied base', () => {
  const base = normalizeSettings({
    palette: 'graphite',
    proactivity: 'eager',
    codexHeartbeatSeconds: 90,
    voice: 'longcheng',
  })
  const merged = normalizeSettings({ palette: 'ember', proactivity: 'nonsense' }, base)

  assert.equal(merged.palette, 'ember')
  assert.equal(merged.proactivity, 'eager')
  assert.equal(merged.codexHeartbeatSeconds, 90)
  assert.equal(merged.voice, 'longcheng')
})

test('normalizeSettings keeps only well-formed secret entries', () => {
  const normalized = normalizeSettings({
    secrets: {
      dashscopeApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' },
      tavilyApiKey: { enc: 'none', data: 'aGk=' },
      modelApiKey: { enc: 'rot13', data: 'aGk=' },
      codexApiKey: { enc: 'none', data: 'not base64!' },
      strayKey: { enc: 'none', data: 'aGk=' },
    },
  })

  assert.deepEqual(normalized.secrets, {
    dashscopeApiKey: { enc: 'safeStorage', data: 'c2VhbGVk' },
    tavilyApiKey: { enc: 'none', data: 'aGk=' },
  })
})

test('normalizeSettings rejects secret entries that are not objects or lack data', () => {
  const normalized = normalizeSettings({
    secrets: {
      dashscopeApiKey: 'plaintext-would-be-a-bug',
      tavilyApiKey: { enc: 'none' },
      modelApiKey: { enc: 'none', data: '' },
      codexApiKey: null,
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
    'codexHeartbeatSeconds',
    'palette',
    'proactivity',
    'version',
    'voice',
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
  })
  assert.doesNotMatch(JSON.stringify(secretsPresent(settings)), /sk-dash|sk-codex|sealed/)
  assert.deepEqual(secretsPresent(undefined), {
    dashscopeApiKey: false,
    tavilyApiKey: false,
    modelApiKey: false,
    codexApiKey: false,
  })
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
    voice: 'longcheng',
  }, codec)
  const updated = applySettingsUpdate(stored, {
    codexHeartbeatSeconds: 9000,
    secrets: { dashscopeApiKey: 12345, tavilyApiKey: 'x'.repeat(4097) },
  }, codec)

  assert.equal(updated.palette, 'graphite')
  assert.equal(updated.proactivity, 'eager')
  assert.equal(updated.codexHeartbeatSeconds, 75, 'an out-of-range patch keeps the stored value')
  assert.equal(updated.voice, 'longcheng')
  assert.deepEqual(updated.secrets, {})
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
  assert.deepEqual(applySettingsUpdate(DEFAULT_SETTINGS, undefined, codec), DEFAULT_SETTINGS)
  assert.deepEqual(applySettingsUpdate(DEFAULT_SETTINGS, 'palette', codec), DEFAULT_SETTINGS)
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
      voice: 'longcheng',
      secrets: { dashscopeApiKey: 'sk-round-trip' },
    }, fakeCodec())

    await saveSettings(file, settings)

    assert.deepEqual(await loadSettings(file), settings)
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
