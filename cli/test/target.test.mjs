import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {
  desktopSettingsPath,
  PRODUCT_VERSION,
  releaseBaseUrl,
  releaseRoot,
  resolveTarget,
} from '../src/target.mjs'

test('public version and target matrix are stable', () => {
  assert.equal(PRODUCT_VERSION, '0.1.0')
  assert.equal(resolveTarget('darwin', 'arm64').artifact, 'nova-audio-agent-0.1.0-macos-arm64-app.zip')
  assert.equal(resolveTarget('darwin', 'x64').artifact, 'nova-audio-agent-0.1.0-macos-x64-app.zip')
  assert.equal(resolveTarget('win32', 'x64').executable, 'Nova Audio Agent Ambient Orb.exe')
  assert.equal(resolveTarget('linux', 'x64').archive, 'file')
  assert.throws(() => resolveTarget('linux', 'arm64'), /unsupported platform/u)
})

test('release and settings paths use the documented local roots', () => {
  const target = resolveTarget('linux', 'x64')
  assert.equal(
    releaseRoot({home: '/tmp/home', target}),
    '/tmp/home/.nova-audio-agent/cli/releases/0.1.0/linux-x64',
  )
  assert.equal(
    desktopSettingsPath({platform: 'linux', home: '/tmp/home', environment: {}}),
    '/tmp/home/.config/Nova Audio Agent Ambient Orb/ambient-orb-settings.json',
  )
  assert.equal(releaseBaseUrl(), 'https://github.com/deepnovacore/NovaAudioAgent/releases/download/v0.1.0')
})

test('published package and release metadata use strict public allowlists', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const assets = JSON.parse(await readFile(new URL('../release-assets.json', import.meta.url), 'utf8'))
  assert.deepEqual(packageJson.files, ['bin/', 'src/', 'release-assets.json', 'README.md', 'LICENSE'])
  assert.deepEqual(Object.keys(assets.targets).sort(), [
    'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64',
  ])
  for (const [id, entry] of Object.entries(assets.targets)) {
    const {id: resolvedId, ...definition} = resolveTarget(...id.split('-'))
    assert.equal(resolvedId, id)
    assert.deepEqual(entry, definition)
  }
})
