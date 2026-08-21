import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {access} from 'node:fs/promises'
import {resolve} from 'node:path'

const WINDOWS_HARDENING = Object.freeze([
  '/guard:cf',
  '/DYNAMICBASE',
  '/NXCOMPAT',
  '/CETCOMPAT',
  '/HIGHENTROPYVA',
])

async function existing(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function parseEnvironment(output) {
  const environment = {}
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator)
    const normalized = ['PATH', 'INCLUDE', 'LIB'].includes(name.toUpperCase())
      ? name.toUpperCase()
      : name
    environment[normalized] = line.slice(separator + 1)
  }
  return environment
}

async function visualStudioEnvironment() {
  const inherited = {...process.env}
  if (typeof inherited.INCLUDE === 'string' && typeof inherited.LIB === 'string') return inherited
  const programFiles = inherited['ProgramFiles(x86)']
  assert.ok(programFiles, 'windows_msvc_unavailable')
  const vswhere = resolve(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  assert.equal(await existing(vswhere), true, 'windows_msvc_unavailable')
  const located = spawnSync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], {encoding: 'utf8', windowsHide: true})
  assert.equal(located.status, 0, 'windows_msvc_unavailable')
  const installation = located.stdout.replace(/[\r\n]+$/u, '')
  assert.ok(installation.length > 0, 'windows_msvc_unavailable')
  const vcvars = resolve(installation, 'VC/Auxiliary/Build/vcvars64.bat')
  assert.equal(await existing(vcvars), true, 'windows_msvc_unavailable')
  const command = `call "${vcvars}" >nul && set`
  const configured = spawnSync(inherited.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', [
    '/d', '/s', '/c', command,
  ], {encoding: 'utf8', env: inherited, windowsHide: true})
  assert.equal(configured.status, 0, 'windows_msvc_unavailable')
  const environment = parseEnvironment(configured.stdout)
  assert.ok(environment.INCLUDE && environment.LIB && environment.PATH, 'windows_msvc_unavailable')
  return environment
}

export async function compileWindowsNative({
  packageRoot,
  source,
  destination,
  architecture,
  includeDirectories = [],
  definitions = [],
  libraries = [],
  linkOptions = [],
  dll = false,
}) {
  assert.equal(process.platform, 'win32', 'windows_msvc_host_required')
  assert.equal(architecture, 'x64', 'windows_msvc_arch_unsupported')
  const environment = await visualStudioEnvironment()
  const args = [
    '/nologo',
    '/std:c11',
    '/utf-8',
    '/O2',
    '/W4',
    '/WX',
    '/GS',
    '/sdl',
    '/guard:cf',
    '/DWIN32_LEAN_AND_MEAN',
    '/DNOMINMAX',
    '/DUNICODE',
    '/D_UNICODE',
    ...definitions.map(value => `/D${value}`),
    ...includeDirectories.map(value => `/I${value}`),
    ...(dll ? ['/LD'] : []),
    `/Fo${destination}.obj`,
    source,
    ...libraries,
    '/link',
    ...WINDOWS_HARDENING,
    ...linkOptions,
    '/INCREMENTAL:NO',
    `/OUT:${destination}`,
  ]
  const compiled = spawnSync('cl.exe', args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  })
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout || 'windows_native_compile_failed')
}

export async function createWindowsImportLibrary({packageRoot, definition, destination, architecture}) {
  assert.equal(process.platform, 'win32', 'windows_msvc_host_required')
  assert.equal(architecture, 'x64', 'windows_msvc_arch_unsupported')
  const environment = await visualStudioEnvironment()
  const created = spawnSync('lib.exe', [
    '/nologo',
    `/DEF:${definition}`,
    '/MACHINE:X64',
    `/OUT:${destination}`,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  })
  assert.equal(created.status, 0, created.stderr || created.stdout || 'windows_import_library_failed')
}
