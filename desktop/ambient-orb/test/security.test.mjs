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
