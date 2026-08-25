import assert from 'node:assert/strict'
import test from 'node:test'

import * as securityModule from '../src/main/security.mjs'

const { browserWindowOptions, validateBootstrap } = securityModule

test('accepts only loopback websocket bootstrap with a 128-bit token', () => {
  assert.deepEqual(validateBootstrap({
    endpoint: 'ws://127.0.0.1:49152',
    token: 'a'.repeat(32),
  }), {
    endpoint: 'ws://127.0.0.1:49152/',
    token: 'a'.repeat(32),
  })
  assert.throws(() => validateBootstrap({
    endpoint: 'wss://voice.example.com',
    token: 'a'.repeat(32),
  }), /loopback/)
  assert.throws(() => validateBootstrap({
    endpoint: 'ws://127.0.0.1:49152/?token=secret',
    token: 'a'.repeat(32),
  }), /query/)
  assert.throws(() => validateBootstrap({
    endpoint: 'ws://127.0.0.1:49152',
    token: 'short',
  }), /128-bit/)
})

test('pins BrowserWindow isolation sandbox and ephemeral partition', () => {
  const options = browserWindowOptions('/app/preload.cjs', 'launch-1')

  assert.equal(options.transparent, true)
  assert.equal(options.frame, false)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.partition, 'nova-orb-launch-1')
  assert.equal(options.webPreferences.preload, '/app/preload.cjs')
  assert.equal(options.webPreferences.webSecurity, true)
  assert.equal(options.webPreferences.autoplayPolicy, 'no-user-gesture-required')
})

test('memory board window shares the orb session with the same isolation walls', () => {
  const options = securityModule.boardWindowOptions('/app/preload.cjs', 'launch-1')

  assert.equal(options.frame, true)
  assert.equal(options.alwaysOnTop, undefined)
  assert.equal(options.show, false)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.partition, 'nova-orb-launch-1')
  assert.equal(options.webPreferences.preload, '/app/preload.cjs')
  assert.equal(options.webPreferences.webSecurity, true)
})

test('settings window shares the orb session with the same isolation walls', () => {
  const options = securityModule.settingsWindowOptions('/app/preload.cjs', 'launch-1')

  assert.equal(options.width, 420)
  assert.equal(options.height, 560)
  assert.equal(options.title, '设置')
  assert.equal(options.frame, true)
  assert.equal(options.alwaysOnTop, undefined)
  assert.equal(options.show, false)
  assert.equal(options.webPreferences.contextIsolation, true)
  assert.equal(options.webPreferences.nodeIntegration, false)
  assert.equal(options.webPreferences.sandbox, true)
  assert.equal(options.webPreferences.partition, 'nova-orb-launch-1')
  assert.equal(options.webPreferences.preload, '/app/preload.cjs')
  assert.equal(options.webPreferences.webSecurity, true)
  // The orb's autoplay exemption is orb-only; a panel has no audio at all.
  assert.equal(options.webPreferences.autoplayPolicy, undefined)
})

test('settings window rejects a missing preload or a forgeable launch id', () => {
  assert.throws(() => securityModule.settingsWindowOptions('', 'launch-1'), /preload/)
  assert.throws(() => securityModule.settingsWindowOptions('/app/preload.cjs', '../evil'), /launch id/)
})

test('browserWindowOptions defaults to the transparent orb backdrop', () => {
  const options = browserWindowOptions('/app/preload.cjs', 'launch-1')

  assert.equal(options.transparent, true)
  assert.equal(options.backgroundColor, '#00000000')
})

test('browserWindowOptions renders an opaque dark plate when the fallback is requested', () => {
  const options = browserWindowOptions('/app/preload.cjs', 'launch-1', { opaque: true })

  assert.equal(options.transparent, false)
  assert.equal(options.backgroundColor, '#141005')
})

test('browserWindowOptions treats opaque: false the same as omitting the option', () => {
  const options = browserWindowOptions('/app/preload.cjs', 'launch-1', { opaque: false })

  assert.equal(options.transparent, true)
  assert.equal(options.backgroundColor, '#00000000')
})

test('bootstrap remains reload-safe for the same renderer and rejects every other caller', () => {
  assert.equal(typeof securityModule.createBootstrapAccess, 'function')
  const renderer = {}
  const bootstrap = Object.freeze({ endpoint: 'ws://127.0.0.1:43123/', token: 'a'.repeat(32) })
  const read = securityModule.createBootstrapAccess(bootstrap, renderer)

  assert.equal(read(renderer), bootstrap)
  assert.equal(read(renderer), bootstrap)
  assert.throws(() => read({}), /unavailable/)
})

test('media request policy catches lookalike origins, panels, and invalid media subsets', () => {
  assert.equal(typeof securityModule.allowsOrbMediaRequest, 'function')
  const renderer = {}
  const base = {
    contents: renderer,
    renderer,
    permission: 'media',
    origin: 'nova://orb',
  }
  for (const mediaTypes of [['audio'], ['video'], ['audio', 'video']]) {
    assert.equal(
      securityModule.allowsOrbMediaRequest({ ...base, mediaTypes }),
      true,
      JSON.stringify(mediaTypes),
    )
  }

  const denied = [
    ['different contents', { ...base, contents: {} , mediaTypes: ['video'] }],
    ['lookalike host', { ...base, origin: 'nova://orb.evil', mediaTypes: ['video'] }],
    ['credential host', { ...base, origin: 'nova://orb@evil', mediaTypes: ['video'] }],
    ['different host', { ...base, origin: 'nova://other', mediaTypes: ['video'] }],
    ['path lookalike', { ...base, origin: 'nova://orb/index.html', mediaTypes: ['video'] }],
    ['dot path lookalike', { ...base, origin: 'nova://orb/.', mediaTypes: ['video'] }],
    ['normalized path lookalike', { ...base, origin: 'nova://orb/foo/..', mediaTypes: ['video'] }],
    ['encoded dot path lookalike', { ...base, origin: 'nova://orb/%2e%2e', mediaTypes: ['video'] }],
    ['query lookalike', { ...base, origin: 'nova://orb?source=video', mediaTypes: ['video'] }],
    ['empty query lookalike', { ...base, origin: 'nova://orb/?', mediaTypes: ['video'] }],
    ['empty fragment lookalike', { ...base, origin: 'nova://orb/#', mediaTypes: ['video'] }],
    ['empty credential lookalike', { ...base, origin: 'nova://@orb/', mediaTypes: ['video'] }],
    ['empty port lookalike', { ...base, origin: 'nova://orb:/', mediaTypes: ['video'] }],
    ['wrong permission', { ...base, permission: 'display-capture', mediaTypes: ['video'] }],
    ['missing media types', base],
    ['empty media types', { ...base, mediaTypes: [] }],
    ['duplicate media types', { ...base, mediaTypes: ['video', 'video'] }],
    ['screen media type', { ...base, mediaTypes: ['screen'] }],
    ['mixed unknown media type', { ...base, mediaTypes: ['audio', 'screen'] }],
  ]
  for (const [name, input] of denied) {
    assert.equal(securityModule.allowsOrbMediaRequest(input), false, name)
  }
})

test('media check policy accepts Electron custom-scheme roots without weakening renderer identity', () => {
  assert.equal(typeof securityModule.allowsOrbMediaCheck, 'function')
  const renderer = {}
  const base = {
    contents: renderer,
    renderer,
    permission: 'media',
    origin: 'nova://orb',
  }
  assert.equal(securityModule.allowsOrbMediaCheck(base), true)
  assert.equal(securityModule.allowsOrbMediaCheck({ ...base, origin: 'nova://orb/' }), true)
  assert.equal(securityModule.allowsOrbMediaCheck({
    ...base,
    origin: '',
    mediaType: 'audio',
  }), true)
  assert.equal(securityModule.allowsOrbMediaCheck({ ...base, contents: {} }), false)
  assert.equal(securityModule.allowsOrbMediaCheck({ ...base, permission: 'camera' }), false)
  assert.equal(securityModule.allowsOrbMediaCheck({ ...base, origin: '', mediaType: 'screen' }), false)
  assert.equal(securityModule.allowsOrbMediaCheck({ ...base, origin: 'nova://orb.evil' }), false)
})

test('window security installs one policy pair and invokes each request callback once', () => {
  assert.equal(typeof securityModule.configureWindowSecurity, 'function')
  let checkHandler
  let requestHandler
  let checkInstalls = 0
  let requestInstalls = 0
  const renderer = {
    setWindowOpenHandler() {},
    on() {},
    session: {
      setPermissionCheckHandler(handler) {
        checkInstalls += 1
        checkHandler = handler
      },
      setPermissionRequestHandler(handler) {
        requestInstalls += 1
        requestHandler = handler
      },
    },
  }
  securityModule.configureWindowSecurity({ webContents: renderer })

  assert.equal(checkInstalls, 1)
  assert.equal(requestInstalls, 1)
  assert.equal(checkHandler(renderer, 'media', 'nova://orb', {}), true)
  assert.equal(
    checkHandler(renderer, 'media', '', { mediaType: 'audio' }),
    true,
    'Electron custom-scheme audio preflight is allowed',
  )
  assert.equal(checkHandler({}, 'media', 'nova://orb', {}), false, 'a panel is denied')
  assert.equal(
    checkHandler({}, 'media', '', { mediaType: 'audio' }),
    false,
    'an empty-origin panel is denied',
  )

  for (const [name, contents, details, expected] of [
    ['main video', renderer, { securityOrigin: 'nova://orb', mediaTypes: ['video'] }, true],
    ['normalized main audio', renderer, { securityOrigin: 'nova://orb/', mediaTypes: ['audio'] }, true],
    ['main audio/video', renderer, { securityOrigin: 'nova://orb', mediaTypes: ['audio', 'video'] }, true],
    ['panel video', {}, { securityOrigin: 'nova://orb', mediaTypes: ['video'] }, false],
    ['missing security origin', renderer, { mediaTypes: ['video'] }, false],
    ['duplicate video', renderer, { securityOrigin: 'nova://orb', mediaTypes: ['video', 'video'] }, false],
  ]) {
    const values = []
    requestHandler(contents, 'media', value => values.push(value), details)
    assert.deepEqual(values, [expected], name)
  }
})

test('main camera permission helper catches prompting or examining permissions in file mode', async () => {
  assert.equal(typeof securityModule.requestLocalCameraPermission, 'function')
  for (const [name, source, platform, status, expected] of [
    ['local not determined', 'local', 'darwin', 'not-determined', ['status', 'ask']],
    ['local already granted', 'local', 'darwin', 'granted', ['status']],
    ['local non-mac', 'local', 'linux', 'not-determined', []],
    ['file mac', 'file', 'darwin', 'not-determined', []],
    ['file non-mac', 'file', 'linux', 'not-determined', []],
  ]) {
    const calls = []
    await securityModule.requestLocalCameraPermission(source, {
      platform,
      systemPreferences: {
        getMediaAccessStatus(kind) {
          assert.equal(kind, 'camera')
          calls.push('status')
          return status
        },
        async askForMediaAccess(kind) {
          assert.equal(kind, 'camera')
          calls.push('ask')
          return false
        },
      },
    })
    assert.deepEqual(calls, expected, name)
  }
})

test('main microphone helper resolves macOS TCC only when the renderer requests it', async () => {
  assert.equal(typeof securityModule.resolveMicrophonePermission, 'function')
  for (const [name, platform, statuses, expectedCalls, expectedStatus] of [
    ['mac not determined then granted', 'darwin', ['not-determined', 'granted'], ['status', 'ask', 'status'], 'granted'],
    ['mac not determined then denied', 'darwin', ['not-determined', 'denied'], ['status', 'ask', 'status'], 'denied'],
    ['mac granted', 'darwin', ['granted'], ['status'], 'granted'],
    ['mac denied', 'darwin', ['denied'], ['status'], 'denied'],
    ['mac restricted', 'darwin', ['restricted'], ['status'], 'restricted'],
    ['windows', 'win32', ['not-determined'], [], 'unknown'],
    ['linux', 'linux', ['not-determined'], [], 'unknown'],
  ]) {
    const calls = []
    let index = 0
    const result = await securityModule.resolveMicrophonePermission({
      platform,
      systemPreferences: {
        getMediaAccessStatus(kind) {
          assert.equal(kind, 'microphone')
          calls.push('status')
          return statuses[Math.min(index++, statuses.length - 1)]
        },
        async askForMediaAccess(kind) {
          assert.equal(kind, 'microphone')
          calls.push('ask')
          return true
        },
      },
    })
    assert.deepEqual(calls, expectedCalls, name)
    assert.deepEqual(result, { status: expectedStatus }, name)
  }
})
