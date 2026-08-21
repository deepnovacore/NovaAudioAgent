import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, stat} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

export async function buildCodexSandboxProbe({packageRoot, outputRoot, platform, arch}) {
  assert.ok(platform === 'darwin' || platform === 'linux', 'codex_sandbox_probe_platform_unsupported')
  assert.ok(arch === 'arm64' || arch === 'x64', 'codex_sandbox_probe_arch_unsupported')
  const source = resolve(packageRoot, 'native/codex-sandbox-probe/codex_sandbox_probe_posix.c')
  const sourceInfo = await stat(source)
  assert.equal(sourceInfo.isFile(), true, 'codex_sandbox_probe_source_invalid')
  const destination = resolve(outputRoot, 'native/codex-sandbox-probe')
  await mkdir(dirname(destination), {recursive: true})
  const compiler = platform === 'darwin' ? '/usr/bin/clang' : '/usr/bin/cc'
  const common = [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    source,
  ]
  const args = platform === 'darwin'
    ? [...common, '-arch', arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=12.0', '-Wl,-pie', '-o', destination]
    : [...common, '-fPIE', '-pie', '-Wl,-z,relro,-z,now', '-o', destination]
  const result = spawnSync(compiler, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {...process.env, ZERO_AR_DATE: '1'},
  })
  assert.equal(result.status, 0, result.stderr || 'codex_sandbox_probe_compile_failed')
  await chmod(destination, 0o755)
  const outputInfo = await stat(destination)
  assert.equal(outputInfo.isFile(), true, 'codex_sandbox_probe_compile_failed')
  assert.ok(outputInfo.size > 0, 'codex_sandbox_probe_compile_failed')
  assert.equal(outputInfo.mode & 0o111, 0o111, 'codex_sandbox_probe_compile_failed')
  return destination
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const packageRoot = resolve(import.meta.dirname, '..')
  const destination = await buildCodexSandboxProbe({
    packageRoot,
    outputRoot: resolve(packageRoot, 'build'),
    platform: process.platform,
    arch: process.arch,
  })
  process.stdout.write(`${destination}\n`)
}
