import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import test from 'node:test'

import {buildWindowsJobGuardian} from '../scripts/build-windows-job-guardian.mjs'

const packageRoot = resolve(import.meta.dirname, '..')
const targetFixture = resolve(import.meta.dirname, 'fixtures/windows-guardian-target.cjs')

function waitForText(stream, predicate, timeoutMs = 10_000) {
  return new Promise((resolveWait, rejectWait) => {
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectWait(new Error('bounded Windows guardian output wait expired'))
    }, timeoutMs)
    const onData = chunk => {
      output += String(chunk)
      if (predicate(output)) {
        cleanup()
        resolveWait(output)
      }
    }
    const onClose = () => {
      cleanup()
      rejectWait(new Error('Windows guardian output closed early'))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stream.off('data', onData)
      stream.off('close', onClose)
    }
    stream.on('data', onData)
    stream.on('close', onClose)
  })
}

function processGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

async function waitProcessGone(pid) {
  const deadline = Date.now() + 5_000
  while (!processGone(pid) && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  assert.equal(processGone(pid), true)
}

async function launchGuardian(guardian, cwd, targetArguments) {
  const environment = {...process.env}
  // A Node target launched by the guardian is a product process, not another
  // worker in the surrounding `node --test` control plane.
  delete environment.NODE_TEST_CONTEXT
  delete environment.NODE_TEST_WORKER_ID
  const child = spawn(guardian, [
    '--target', process.execPath,
    '--cwd', cwd,
    '--', process.execPath,
    ...targetArguments,
  ], {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', 'overlapped'],
  })
  const control = child.stdio[3]
  assert.ok(child.stdin && child.stdout && child.stderr && control)
  return {child, control}
}

test('Windows Job guardian keeps leader-first descendants owned and force-closes the complete tree', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'nova-windows-guardian-build-'))
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'nova-windows-guardian-fixture-'))
  const marker = resolve(fixtureRoot, 'grandchild-alive')
  await writeFile(marker, '')
  let child = null
  let control = null
  try {
    const guardian = await buildWindowsJobGuardian({
      packageRoot,
      outputRoot,
      platform: process.platform,
      arch: process.arch,
    })
    ;({child, control} = await launchGuardian(guardian, await realpath(packageRoot), [
      targetFixture, 'leader-first', marker,
    ]))
    const readyPromise = waitForText(control, value => value.includes('\n'))
    const targetPromise = waitForText(child.stdout, value => value.includes('\n'))
    const ready = await readyPromise
    assert.match(ready, /^\{"type":"ready","version":1,"targetPid":\d+\}\n/u)
    const targetPid = Number(/"targetPid":(\d+)/u.exec(ready)?.[1])
    assert.ok(Number.isSafeInteger(targetPid) && targetPid > 0)
    const targetLine = await targetPromise
    const match = /^grandchild:(\d+)\n/u.exec(targetLine)
    assert.ok(match)
    const grandchildPid = Number(match[1])
    assert.equal(processGone(grandchildPid), false)
    // Prove the leader has already exited naturally before forcing the Job;
    // otherwise TerminateJobObject legitimately assigns it exit code 1 and
    // the test no longer exercises the leader-first case its name promises.
    await waitProcessGone(targetPid)
    const exitPromise = waitForText(control, value => value.includes('"treeEmpty":true}\n'))
    control.write('{"type":"force","version":1}\n')
    const exited = await exitPromise
    assert.match(exited, /\{"type":"exit","version":1,"leaderExitCode":0,"treeEmpty":true\}\n/u)
    const guardianExit = await new Promise(resolveExit => child.once('exit', resolveExit))
    assert.equal(guardianExit, 0)
    await waitProcessGone(grandchildPid)
  } finally {
    if (child?.exitCode === null) child.kill()
    control?.destroy()
    await rm(fixtureRoot, {recursive: true, force: true})
    await rm(outputRoot, {recursive: true, force: true})
  }
})

test('Windows Job guardian treats owner-pipe EOF as owner death', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'nova-windows-owner-death-build-'))
  let child = null
  let control = null
  try {
    const guardian = await buildWindowsJobGuardian({
      packageRoot,
      outputRoot,
      platform: process.platform,
      arch: process.arch,
    })
    ;({child, control} = await launchGuardian(
      guardian,
      await realpath(packageRoot),
      [targetFixture, 'hold'],
    ))
    const ready = await waitForText(control, value => value.includes('\n'))
    const targetPid = Number(/"targetPid":(\d+)/u.exec(ready)?.[1])
    assert.ok(Number.isSafeInteger(targetPid) && targetPid > 0)
    control.destroy()
    await new Promise(resolveExit => child.once('exit', resolveExit))
    await waitProcessGone(targetPid)
  } finally {
    if (child?.exitCode === null) child.kill()
    control?.destroy()
    await rm(outputRoot, {recursive: true, force: true})
  }
})
