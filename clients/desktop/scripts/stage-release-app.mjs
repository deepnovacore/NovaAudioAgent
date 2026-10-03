import assert from 'node:assert/strict'
import {cp, mkdir, readFile, realpath, rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {relative, resolve, sep} from 'node:path'

// Materialize the installed production graph. npm owns resolution and integrity;
// staging only removes development files and the unused optional ffmpeg binaries.
export async function stageReleaseApplication({packageRoot}) {
  const stageRoot = resolve(packageRoot, 'build/release-app')
  await rm(stageRoot, {recursive: true, force: true})
  await mkdir(stageRoot, {recursive: true, mode: 0o700})
  for (const name of ['src', 'LICENSES', 'package.json', 'THIRD_PARTY_NOTICES.md']) {
    await cp(resolve(packageRoot, name), resolve(stageRoot, name), {recursive: true})
  }
  const selected = new Map()
  const queue = [{source: packageRoot, destination: stageRoot}]
  while (queue.length) {
    const {source, destination} = queue.shift()
    const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
    const optional = manifest.optionalDependencies ?? {}
    for (const name of Object.keys({...manifest.dependencies, ...optional, ...manifest.peerDependencies})) {
      if (manifest.name === '@livekit/av' && name.startsWith('@livekit/av-')) continue
      const search = createRequire(resolve(source, 'package.json')).resolve.paths('nova-package-resolution') ?? []
      let dependency
      for (const directory of search) {
        try { dependency = await realpath(resolve(directory, name)); break } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      if (!dependency) {
        if (name in optional || manifest.peerDependenciesMeta?.[name]?.optional) continue
        throw new Error(`production dependency missing: ${name}`)
      }
      const meta = JSON.parse(await readFile(resolve(dependency, 'package.json'), 'utf8'))
      if ((meta.os && !meta.os.includes(process.platform)) || (meta.cpu && !meta.cpu.includes(process.arch))) {
        assert.ok(name in optional, `production dependency wrong platform: ${name}`)
        continue
      }
      // Keep one copy per installed identity; a conflicting version remains nested.
      let target = resolve(stageRoot, 'node_modules', name)
      if (selected.has(target) && selected.get(target) !== dependency) target = resolve(destination, 'node_modules', name)
      if (selected.has(target)) {
        assert.equal(selected.get(target), dependency, `production dependency conflict: ${name}`)
        continue
      }
      selected.set(target, dependency)
      await cp(dependency, target, {
        recursive: true,
        dereference: true,
        filter(path) {
          const local = relative(dependency, path).split(sep).join('/')
          if (/(^|\/)(node_modules|test|tests|__tests__|fixtures|coverage)(\/|$)/u.test(local)) return false
          if (/\.(map|ts|cts|mts|snap|png)$/u.test(local) || /\.test\.[cm]?js$/u.test(local)) return false
          if (meta.name === '@nova-audio-agent/runtime') return local === '' || local === 'package.json' || local === 'dist'
            || local === 'scripts' || local === 'scripts/autoglm-bridge.py' || /^dist\/(?:src|eval)(?:\/|$)/u.test(local)
          if (meta.name === '@livekit/agents' && /^resources\/.*\.ogg$/u.test(local)) return false
          return true
        },
      })
      queue.push({source: dependency, destination: target})
    }
  }
  return stageRoot
}
