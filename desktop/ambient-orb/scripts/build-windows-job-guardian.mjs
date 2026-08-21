import assert from 'node:assert/strict'
import {mkdir, stat} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

import {compileWindowsNative} from './windows-msvc.mjs'

export async function buildWindowsJobGuardian({packageRoot, outputRoot, platform, arch}) {
  assert.equal(platform, 'win32', 'windows_job_guardian_platform_unsupported')
  assert.equal(arch, 'x64', 'windows_job_guardian_arch_unsupported')
  const source = resolve(packageRoot, 'native/windows/job-launcher/windows_job_guardian.c')
  assert.equal((await stat(source)).isFile(), true, 'windows_job_guardian_source_invalid')
  const destination = resolve(outputRoot, 'native/windows-job-guardian.exe')
  await mkdir(dirname(destination), {recursive: true})
  await compileWindowsNative({
    packageRoot,
    source,
    destination,
    architecture: arch,
    libraries: ['Advapi32.lib'],
  })
  const output = await stat(destination)
  assert.equal(output.isFile(), true, 'windows_job_guardian_compile_failed')
  assert.ok(output.size > 0, 'windows_job_guardian_compile_failed')
  return destination
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const packageRoot = resolve(import.meta.dirname, '..')
  const destination = await buildWindowsJobGuardian({
    packageRoot,
    outputRoot: resolve(packageRoot, 'build'),
    platform: process.platform,
    arch: process.arch,
  })
  process.stdout.write(`${destination}\n`)
}
