import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {PassThrough} from 'node:stream'
import test from 'node:test'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createPackageWithOptions, uncache} from '@electron/asar'
import {inspectApplication, readReadiness, prepareSmokeHome} from '../scripts/verify-release.mjs'
import {loadSettings} from '../src/main/settings-store.mjs'
import {backendLaunchSpec} from '../src/main/backend.mjs'
import {describeMissingBlockingEnvironment} from '@nova-audio-agent/runtime/desktop'
import {expectedNativeResources} from '../scripts/native-resource-contract.mjs'
import {stageReleaseApplication} from '../scripts/stage-release-app.mjs'

async function file(root, name, body = 'fixture') {
  await mkdir(dirname(join(root, name)), {recursive: true})
  await writeFile(join(root, name), body)
}

test('installed smoke selects the controlled provider without requiring unrelated credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-smoke-settings-')), home = join(root, 'home')
  try {
    await prepareSmokeHome(home)
    const settings = await loadSettings(join(home, 'ambient-orb-settings.json'))
    const spec = backendLaunchSpec({nodeEntry: join(home, 'entry.js'), nodeResourcesPath: home,
      workspace: home, token: 'a'.repeat(32), readyEndpoint: '127.0.0.1:1234', settings,
      parentEnv: {DASHSCOPE_API_KEY: 'public-release-smoke-key', QWEN_REALTIME_URL: 'wss://127.0.0.1:1234'}})
    assert.equal(spec.env.PIPELINE_MODE, 'integrated')
    assert.deepEqual(describeMissingBlockingEnvironment(spec.env, true)?.missing ?? [], [])
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('release version gate rejects stale candidate inputs and divergent package versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-version-'))
  const script = fileURLToPath(new URL('../scripts/check-release-version.mjs', import.meta.url))
  try {
    for (const [candidate, cli, desktop, accepted] of [
      ['1.2.3', '1.2.3', '1.2.3', true],
      ['0.3.0-preview.1', '0.3.0-preview.1', '0.3.0-preview.1', true],
      ['0.3.0-preview.01', '0.3.0-preview.01', '0.3.0-preview.01', false],
      ['0.3.0-beta.1', '0.3.0-beta.1', '0.3.0-beta.1', false],
      ['0.1.1', '1.2.3', '1.2.3', false],
      ['1.2.3', '1.2.4', '1.2.3', false],
      ['1.2.3', '1.2.3', '1.2.4', false],
      ['invalid', 'invalid', 'invalid', false],
    ]) {
      await file(root, 'cli/package.json', JSON.stringify({version: cli}))
      await file(root, 'clients/desktop/package.json', JSON.stringify({version: desktop}))
      const result = spawnSync(process.execPath, [script], {cwd: root, env: {...process.env, RELEASE_VERSION: candidate}, encoding: 'utf8'})
      assert.equal(result.status === 0, accepted, `${candidate}/${cli}/${desktop}: ${result.stderr}`)
    }
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('release verifier rejects packed native modules and missing unpacked resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-release-test-'))
  try {
    const source = join(root, 'source'), resources = join(root, 'resources')
    await file(source, 'src/main/main.mjs')
    await file(source, 'node_modules/test/addon.node')
    for (const entry of expectedNativeResources('darwin-arm64')) {
      if (entry.relative_path.startsWith('app.asar.unpacked/')) await file(source, entry.relative_path.slice('app.asar.unpacked/'.length))
    }
    await mkdir(resources)
    const archive = join(resources, 'app.asar')
    await createPackageWithOptions(source, archive, {})
    await assert.rejects(inspectApplication(resources, 'darwin-arm64'), /ASAR unpack placement/u)
    await createPackageWithOptions(source, archive, {unpack: '**/*.node'})
    uncache(archive)
    for (const entry of expectedNativeResources('darwin-arm64')) await file(resources, entry.relative_path)
    await file(resources, 'native-resources-v1.json', JSON.stringify({target: 'darwin-arm64'}))
    await inspectApplication(resources, 'darwin-arm64')
    await rm(join(resources, 'native/project-native/nova_project_native.node'))
    await assert.rejects(inspectApplication(resources, 'darwin-arm64'), /ENOENT/u)
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('readiness accepts only a loopback endpoint and bounded capability token', async () => {
  for (const endpoint of ['ws://127.0.0.1:1234/', 'wss://example.com/', 'ws://127.0.0.1:99999/']) {
    const stream = new PassThrough()
    const ready = readReadiness(stream)
    stream.end(`${JSON.stringify({type: 'ready', endpoint, token: 'a'.repeat(32)})}\n`)
    if (endpoint === 'ws://127.0.0.1:1234/') assert.equal((await ready).endpoint, endpoint)
    else await assert.rejects(ready, /readiness failed/u)
  }
})

test('staging preserves nested dependency versions and omits development files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-stage-test-'))
  const json = value => JSON.stringify(value)
  try {
    await file(root, 'package.json', json({name: 'desktop', dependencies: {a: '1', b: '1'}}))
    for (const name of ['src/main.mjs', 'LICENSES/MIT', 'THIRD_PARTY_NOTICES.md']) await file(root, name)
    await file(root, 'node_modules/a/package.json', json({name: 'a', dependencies: {c: '1'}}))
    await file(root, 'node_modules/b/package.json', json({name: 'b', dependencies: {c: '2'}}))
    await file(root, 'node_modules/c/package.json', json({name: 'c', version: '1'}))
    await file(root, 'node_modules/b/node_modules/c/package.json', json({name: 'c', version: '2'}))
    await file(root, 'node_modules/c/test/unused.js')
    const staged = await stageReleaseApplication({packageRoot: root})
    const {readFile, access} = await import('node:fs/promises')
    assert.equal(JSON.parse(await readFile(join(staged, 'node_modules/c/package.json'))).version, '1')
    assert.equal(JSON.parse(await readFile(join(staged, 'node_modules/b/node_modules/c/package.json'))).version, '2')
    await assert.rejects(access(join(staged, 'node_modules/c/test/unused.js')), /ENOENT/u)
  } finally { await rm(root, {recursive: true, force: true}) }
})


test('staging keeps the runtime CLI evaluation imports executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nova-stage-runtime-'))
  const runtime = 'node_modules/@nova-audio-agent/runtime'
  try {
    await file(root, 'package.json', JSON.stringify({dependencies: {'@nova-audio-agent/runtime': '1'}}))
    for (const name of ['src/main.mjs', 'LICENSES/MIT', 'THIRD_PARTY_NOTICES.md']) await file(root, name)
    await file(root, `${runtime}/package.json`, JSON.stringify({name: '@nova-audio-agent/runtime', type: 'module', files: ['dist/src', 'dist/eval']}))
    await file(root, `${runtime}/dist/src/cli.js`, "import {marker} from '../eval/probe.js'; console.log(marker)")
    await file(root, `${runtime}/dist/eval/probe.js`, "export const marker = 'evaluation-ready'")
    await file(root, `${runtime}/scripts/autoglm-bridge.py`, '# supervised bridge')
    await file(root, `${runtime}/scripts/test_autoglm_bridge.py`, '# excluded test')
    const staged = await stageReleaseApplication({packageRoot: root})
    const result = spawnSync(process.execPath, [join(staged, runtime, 'dist/src/cli.js')], {encoding: 'utf8'})
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'evaluation-ready')
    const {readFile, access} = await import('node:fs/promises')
    assert.equal(await readFile(join(staged, runtime, 'scripts/autoglm-bridge.py'), 'utf8'), '# supervised bridge')
    await assert.rejects(access(join(staged, runtime, 'scripts/test_autoglm_bridge.py')), /ENOENT/u)
  } finally { await rm(root, {recursive: true, force: true}) }
})
