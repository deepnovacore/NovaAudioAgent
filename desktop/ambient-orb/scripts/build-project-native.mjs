import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdir, readFile, realpath, stat} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, resolve} from 'node:path'

const require = createRequire(import.meta.url)
const EXPECTED_HEADER_VERSION = '1.9.0'

async function pinnedHeaderDirectory() {
  const manifestPath = require.resolve('node-api-headers/package.json')
  const packageRoot = await realpath(dirname(manifestPath))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.name, 'node-api-headers', 'project_native_header_invalid')
  assert.equal(manifest.version, EXPECTED_HEADER_VERSION, 'project_native_header_invalid')
  const include = await realpath(resolve(packageRoot, 'include'))
  assert.equal(dirname(include), packageRoot, 'project_native_header_invalid')
  const info = await stat(include)
  assert.equal(info.isDirectory(), true, 'project_native_header_invalid')
  return include
}

export async function buildProjectNativeAddon({packageRoot, outputRoot, platform, arch}) {
  assert.ok(platform === 'darwin' || platform === 'linux', 'project_native_platform_unsupported')
  assert.ok(arch === 'arm64' || arch === 'x64', 'project_native_arch_unsupported')
  const include = await pinnedHeaderDirectory()
  const source = resolve(packageRoot, 'native/project-native/project_native_posix.c')
  const sourceInfo = await stat(source)
  assert.equal(sourceInfo.isFile(), true, 'project_native_source_invalid')
  const destination = resolve(outputRoot, 'native/project-native/nova_project_native.node')
  await mkdir(dirname(destination), {recursive: true})

  const compiler = platform === 'darwin' ? '/usr/bin/clang' : '/usr/bin/cc'
  const common = [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fvisibility=hidden',
    '-DNAPI_VERSION=10',
    '-DBUILDING_NODE_EXTENSION',
    `-I${include}`,
    source,
  ]
  const args = platform === 'darwin'
    ? [...common, '-bundle', '-undefined', 'dynamic_lookup', '-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=12.0', '-o', destination]
    : [...common, '-shared', '-fPIC', '-Wl,-z,relro,-z,now', '-o', destination]
  const result = spawnSync(compiler, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {...process.env, ZERO_AR_DATE: '1'},
  })
  assert.equal(result.status, 0, result.stderr || 'project_native_compile_failed')
  const outputInfo = await stat(destination)
  assert.equal(outputInfo.isFile(), true, 'project_native_compile_failed')
  assert.ok(outputInfo.size > 0, 'project_native_compile_failed')
  return destination
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const packageRoot = resolve(import.meta.dirname, '..')
  const destination = await buildProjectNativeAddon({
    packageRoot,
    outputRoot: resolve(packageRoot, 'build'),
    platform: process.platform,
    arch: process.arch,
  })
  process.stdout.write(`${destination}\n`)
}
