import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import test from 'node:test'

import {buildWindowsJobGuardian} from '../scripts/build-windows-job-guardian.mjs'

const packageRoot = resolve(import.meta.dirname, '..')

async function source(relativePath) {
  return await readFile(resolve(packageRoot, relativePath), 'utf8')
}

test('Windows project authority owns nonblocking locks and handle-relative project operations', async () => {
  const body = await source('native/project-native/project_native_windows.c')
  for (const required of [
    /_get_osfhandle/u,
    /DuplicateHandle/u,
    /LockFileEx/u,
    /LOCKFILE_FAIL_IMMEDIATELY/u,
    /NtCreateFile/u,
    /RootDirectory/u,
    /FILE_OPEN_REPARSE_POINT/u,
    /GetSecurityInfo/u,
    /GetTokenInformation/u,
    /SetFileInformationByHandle/u,
    /FileRenameInfo/u,
    /FileDispositionInfoEx/u,
    /__pfnDliNotifyHook2/u,
    /GetModuleHandleW\(NULL\)/u,
  ]) assert.match(body, required)
  for (const exported of [
    'acquire', 'probe', 'matchesAt', 'lookupAt', 'createFileAt', 'mkdirAt', 'renameAt', 'unlinkAt',
  ]) assert.match(body, new RegExp(`"${exported}"`, 'u'))
  assert.doesNotMatch(body, /CreateFileW\s*\(\s*(?:root|path)/u)
})

test('Windows sandbox probe measures child, filesystem, network, and limit isolation', async () => {
  const body = await source('native/codex-sandbox-probe/codex_sandbox_probe_windows.c')
  for (const required of [
    /wmain/u,
    /CreateProcessW/u,
    /CREATE_NO_WINDOW/u,
    /WaitForSingleObject/u,
    /TerminateProcess/u,
    /WSAStartup/u,
    /ioctlsocket/u,
    /cwd_matches/u,
    /inside_write/u,
    /inside_remove/u,
    /outside_write_denied/u,
    /child_outside_write_denied/u,
    /network_denied/u,
    /QueryInformationJobObject/u,
  ]) assert.match(body, required)
  assert.doesNotMatch(body, /ShellExecute|\bsystem\s*\(|taskkill/iu)
})

test('Windows guardian assigns a suspended target before resume and owns owner-death cleanup', async () => {
  assert.equal(typeof buildWindowsJobGuardian, 'function')
  const body = await source('native/windows/job-launcher/windows_job_guardian.c')
  for (const required of [
    /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u,
    /CREATE_SUSPENDED/u,
    /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u,
    /AssignProcessToJobObject/u,
    /ResumeThread/u,
    /JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO/u,
    /ReadFile/u,
    /OVERLAPPED/u,
    /ERROR_IO_PENDING/u,
    /GetOverlappedResult/u,
    /_close\(NOVA_TARGET_STDIN_FD\)/u,
    /_close\(NOVA_TARGET_STDOUT_FD\)/u,
    /_close\(NOVA_TARGET_STDERR_FD\)/u,
    /NOVA_CONTROL_FRAME_LIMIT\s+4096/u,
    /NOVA_CONTROL_FD\s+3/u,
    /NOVA_TARGET_STDIN_FD\s+0/u,
    /NOVA_TARGET_STDOUT_FD\s+1/u,
    /NOVA_TARGET_STDERR_FD\s+2/u,
    /\{\\"type\\":\\"force\\",\\"version\\":1\}\\n/u,
  ]) assert.match(body, required)
  assert.ok(body.indexOf('AssignProcessToJobObject') < body.indexOf('ResumeThread'))
  assert.doesNotMatch(body, /ReadFile\([^;]+NULL\)/su)
  assert.doesNotMatch(body, /WriteFile\([^;]+NULL\)/su)
  assert.match(
    body,
    /CancelIoEx\(output, &operation\);[\s\S]{0,200}GetOverlappedResult\(output, &operation, written, TRUE\)/u,
  )
  assert.doesNotMatch(body, /ShellExecute|\bsystem\s*\(|taskkill/iu)
})

test('Windows native builders select audited sources and MSVC hardening', async () => {
  const project = await source('scripts/build-project-native.mjs')
  const probe = await source('scripts/build-codex-sandbox-probe.mjs')
  const guardian = await source('scripts/build-windows-job-guardian.mjs')
  const compiler = await source('scripts/windows-msvc.mjs')
  for (const body of [project, probe, guardian]) {
    assert.match(body, /win32/u)
  }
  assert.match(compiler, /\/guard:cf/u)
  assert.match(compiler, /\/DYNAMICBASE/u)
  assert.match(compiler, /\/NXCOMPAT/u)
  assert.match(project, /project_native_windows\.c/u)
  assert.match(project, /node_api\.def/u)
  assert.match(project, /createWindowsImportLibrary/u)
  assert.match(project, /\/DELAYLOAD:NODE\.EXE/u)
  assert.match(project, /Delayimp\.lib/u)
  assert.match(compiler, /lib\.exe/u)
  assert.match(probe, /codex_sandbox_probe_windows\.c/u)
  assert.match(guardian, /windows_job_guardian\.c/u)
})
