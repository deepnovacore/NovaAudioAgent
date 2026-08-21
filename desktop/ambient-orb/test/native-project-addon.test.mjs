import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

import {buildProjectNativeAddon} from '../scripts/build-project-native.mjs'

const packageRoot = resolve(import.meta.dirname, '..')

test('project native addon builds for and passes behavior under the packaged Electron ABI', {
  skip: process.platform !== 'darwin',
  timeout: 60_000,
}, async () => {
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'nova-project-native-'))
  const addonPath = await buildProjectNativeAddon({
    packageRoot,
    outputRoot,
    platform: process.platform,
    arch: process.arch,
  })
  const electronPath = resolve(packageRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const result = spawnSync(electronPath, [
    resolve(import.meta.dirname, 'fixtures/project-native-addon-behavior.cjs'),
    addonPath,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /project native behavior passed/)
})
