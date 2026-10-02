import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {acquireDeviceLock, deviceLockPath, quarantineDeviceLock, recordDeviceProcess, releaseDeviceLock} from '../src/executors/device-lock.js'

const DEAD_PID = 2147483646

async function root(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'nova-device-lock-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  return dir
}

async function staleLock(dir: string, extra: Record<string, unknown> = {}) {
  const path = deviceLockPath(dir, 'android', 'serial')
  await mkdir(path)
  await writeFile(join(path, 'owner.json'), JSON.stringify({taskId: 'old', hostPid: DEAD_PID, ...extra}))
  return path
}

test('a quarantined lock is never reclaimed even after its host died', async t => {
  const dir = await root(t)
  const path = await staleLock(dir)
  await writeFile(join(path, 'quarantine.json'), JSON.stringify({taskId: 'old', code: 'cleanup_unknown'}))
  assert.deepEqual(await acquireDeviceLock(dir, 'android', 'serial', 'new'), {ok: false, reason: 'device_busy'})
})

test('a lock whose detached device process survives is never reclaimed', async t => {
  const dir = await root(t)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {detached: true, stdio: 'ignore'})
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } })
  await staleLock(dir, {devicePid: child.pid})
  assert.deepEqual(await acquireDeviceLock(dir, 'android', 'serial', 'new'), {ok: false, reason: 'device_busy'})
})

test('quarantine and recorded processes survive the owning run, and release only removes its own lock', async t => {
  const dir = await root(t)
  const first = await acquireDeviceLock(dir, 'android', 'serial', 'first')
  assert.ok(first.ok)
  await recordDeviceProcess(first.lock, DEAD_PID)
  assert.equal((JSON.parse(await readFile(join(first.lock.path, 'owner.json'), 'utf8')) as Record<string, unknown>).devicePid, DEAD_PID)
  await quarantineDeviceLock(first.lock, 'cleanup_unknown')
  assert.equal(await releaseDeviceLock({path: first.lock.path, taskId: 'someone-else'}), false)
  assert.equal((await readdir(dir)).length, 1)
})

test('concurrent contenders for one stale lock produce exactly one owner', async t => {
  const dir = await root(t)
  await staleLock(dir)
  const results = await Promise.all(Array.from({length: 8}, (_, i) => acquireDeviceLock(dir, 'android', 'serial', `task-${i}`)))
  assert.equal(results.filter(result => result.ok).length, 1)
  const winner = results.find(result => result.ok)!
  assert.ok(winner.ok)
  assert.equal((JSON.parse(await readFile(join(winner.lock.path, 'owner.json'), 'utf8')) as Record<string, unknown>).taskId, winner.lock.taskId)
  assert.deepEqual((await readdir(dir)).filter(name => name.includes('.stale-')), [])
})
