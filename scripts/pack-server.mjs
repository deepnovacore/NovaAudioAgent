import assert from 'node:assert/strict'
import {chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve, join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {buildProjectNativeAddon} from '../clients/desktop/scripts/build-project-native.mjs'
import {buildCodexSandboxProbe} from '../clients/desktop/scripts/build-codex-sandbox-probe.mjs'
import {stageEndpointingProbeAssets} from '../clients/desktop/scripts/stage-endpointing-probe-assets.mjs'
import {generateSourceHostResourceManifest} from '../clients/desktop/scripts/native-resource-contract.mjs'

// Keep one runtime dependency authority; npm resolves native addons for the host.
export async function packServer({root = resolve(import.meta.dirname, '..'), destination}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build the Ubuntu server package on Linux x64')
  const output = resolve(destination ?? join(root, 'server-cli/dist'))
  await mkdir(output, {recursive: true})
  const stage = await mkdtemp(join(tmpdir(), 'nova-server-package-'))
  try {
    const runtime = JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8'))
    const cli = JSON.parse(await readFile(join(root, 'cli/package.json'), 'utf8'))
    const manifest = {
      name: 'nova-audio-agent-server', version: cli.version,
      description: 'Headless Nova Audio Agent service and terminal device pairing.',
      type: 'module', bin: {'novaaudio-server': 'bin/novaaudio-server.mjs'},
      engines: {node: '>=22.14.0'}, os: ['linux'], cpu: ['x64'],
      files: ['bin/', 'src/', 'runtime/dist/src/', 'runtime/dist/eval/', 'runtime/scripts/pair-device.mjs', 'resources/', 'README.md', 'LICENSE'],
      dependencies: runtime.dependencies, license: cli.license,
      repository: cli.repository, homepage: cli.homepage, publishConfig: cli.publishConfig,
    }
    await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    for (const path of ['bin', 'src', 'README.md']) await cp(join(root, 'server-cli', path), join(stage, path), {recursive: true})
    await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'))
    for (const path of ['dist/src', 'dist/eval', 'scripts/pair-device.mjs']) {
      await mkdir(resolve(stage, 'runtime', path, '..'), {recursive: true})
      await cp(join(root, 'runtime', path), join(stage, 'runtime', path), {recursive: true, filter: source => !source.endsWith('.map') && !source.endsWith('.d.ts')})
    }
    const resourcesRoot = join(stage, 'resources')
    const nativeOptions = {packageRoot: join(root, 'clients/desktop'), outputRoot: resourcesRoot, platform: process.platform, arch: process.arch}
    await buildProjectNativeAddon(nativeOptions)
    await buildCodexSandboxProbe(nativeOptions)
    await stageEndpointingProbeAssets({repositoryRoot: root, outputRoot: resourcesRoot})
    const nativeManifest = await generateSourceHostResourceManifest({resourcesRoot, targetId: 'linux-x64-gnu'})
    const resources = nativeManifest.resources.map(record => record.logical_id === 'project_native_addon'
      ? {...record, electron_abi: null, node_api_version: 10} : record)
    await writeFile(join(resourcesRoot, 'native-resources-v1.json'), JSON.stringify({...nativeManifest, resources}) + '\n')
    const executables = new Set(['bin/novaaudio-server.mjs', 'resources/native/codex-sandbox-probe'])
    for (const name of ['', ...await readdir(stage, {recursive: true})]) {
      const path = join(stage, name)
      await chmod(path, (await stat(path)).isDirectory() || executables.has(name) ? 0o755 : 0o644)
    }
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', stage, '--ignore-scripts', '--pack-destination', output, '--json'], {encoding: 'utf8'})
    if (result.status !== 0) throw new Error(result.stderr || 'server npm pack failed')
    const [{filename, files}] = JSON.parse(result.stdout)
    const allowed = new Set(['package.json', 'README.md', 'LICENSE', 'bin/novaaudio-server.mjs', 'src/command.mjs',
      'runtime/scripts/pair-device.mjs', 'resources/native-resources-v1.json',
      'resources/native/project-native/nova_project_native.node', 'resources/native/codex-sandbox-probe',
      ...['MANIFEST.json', 'LICENSE.silero-vad.txt', 'speech-16k-s16le.pcm', 'silence-16k-s16le.pcm'].map(name => `resources/endpointing/volcengine-v1/${name}`)])
    for (const {path, mode} of files) {
      assert.ok(!path.split('/').includes('..') && (allowed.has(path) || /^runtime\/dist\/(src|eval)\/.+\.js$/u.test(path)), `unexpected server package file: ${path}`)
      assert.equal(mode & 0o777, executables.has(path) ? 0o755 : 0o644, `server package mode: ${path}`)
    }
    return join(output, filename)
  } finally { await rm(stage, {recursive: true, force: true}) }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(await packServer({destination: process.argv[2]}))
}
