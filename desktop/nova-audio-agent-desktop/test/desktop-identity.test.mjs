import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {configureDesktopIdentity, DESKTOP_PRODUCT_NAME, LEGACY_STORAGE_NAME} from '../src/main/desktop-identity.mjs'

test('desktop rename preserves encryption identity before ready and displays the new name after ready', async () => {
  let ready, name
  const paths = {appData: '/profile', userData: '/new-default'}
  const pending = new Promise(resolve => { ready = resolve })
  const app = {
    commandLine: {hasSwitch: () => false},
    setName(value) { name = value },
    getPath(key) { return paths[key] },
    setPath(key, value) { paths[key] = value },
    whenReady: () => pending,
  }
  const configured = configureDesktopIdentity(app)
  assert.equal(name, LEGACY_STORAGE_NAME)
  assert.equal(paths.userData, join('/profile', LEGACY_STORAGE_NAME))
  ready()
  await configured
  assert.equal(name, DESKTOP_PRODUCT_NAME)
})

test('an explicit isolated user-data directory is preserved', async () => {
  const configured = configureDesktopIdentity({
    commandLine: {hasSwitch: name => name === 'user-data-dir'},
    setName() {},
    getPath() { throw new Error('must not read a default profile') },
    setPath() { throw new Error('must not replace isolated profile') },
    whenReady: () => Promise.resolve(),
  })
  await configured
})
