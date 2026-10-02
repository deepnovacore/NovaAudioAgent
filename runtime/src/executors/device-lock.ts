/** One canonical lock per physical device, shared by every phone engine. */
import {createHash, randomUUID} from 'node:crypto'
import {access, mkdir, readFile, rename, rm, rmdir, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export interface DeviceLock { readonly path: string; readonly taskId: string }

const OWNER = 'owner.json'
const QUARANTINE = 'quarantine.json'

/** A Simulator reached as `ios` or `ios-simulator` is the same handset for ownership purposes. */
export function deviceLockPath(lockRoot: string, deviceType: string, deviceId: string): string {
  const platform = deviceType === 'ios-simulator' ? 'ios' : deviceType
  return join(lockRoot, createHash('sha256').update(`${platform}:${deviceId}`).digest('hex'))
}

function alive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0)
    return true
  } catch (error) {
    // A live process owned by someone else still holds the device.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const validPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * A lock is reclaimable only when its host is dead, it was never quarantined, and no recorded device
 * process survives. Anything unreadable stays held for manual recovery.
 */
async function reclaimable(path: string): Promise<string | null> {
  try {
    await access(join(path, QUARANTINE))
    return null
  } catch { /* Not quarantined. */ }
  try {
    const raw = await readFile(join(path, OWNER), 'utf8')
    const owner = record(JSON.parse(raw))
    if (!validPid(owner.hostPid) || alive(owner.hostPid)) return null
    if (owner.devicePid !== undefined && (!validPid(owner.devicePid) || alive(owner.devicePid, true))) return null
    return raw
  } catch {
    return null
  }
}

export async function acquireDeviceLock(lockRoot: string, deviceType: string, deviceId: string, taskId: string):
Promise<{ok: true; lock: DeviceLock} | {ok: false; reason: 'device_busy' | 'device_lock_failed'}> {
  const path = deviceLockPath(lockRoot, deviceType, deviceId)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path, {mode: 0o700})
      try {
        await writeFile(join(path, OWNER), JSON.stringify({taskId, hostPid: process.pid}), {mode: 0o600, flag: 'wx'})
      } catch {
        await rmdir(path).catch(() => undefined)
        return {ok: false, reason: 'device_lock_failed'}
      }
      return {ok: true, lock: {path, taskId}}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return {ok: false, reason: 'device_lock_failed'}
    }
    const stale = await reclaimable(path)
    if (stale === null) return {ok: false, reason: 'device_busy'}
    // Rename is atomic: of several contenders exactly one moves the stale lock aside.
    const tombstone = `${path}.stale-${randomUUID()}`
    try { await rename(path, tombstone) } catch { continue }
    const moved = await readFile(join(tombstone, OWNER), 'utf8').catch(() => null)
    if (moved !== stale) {
      // A contender replaced the stale lock first; hand its live lock back untouched.
      try { await rename(tombstone, path) } catch { return {ok: false, reason: 'device_lock_failed'} }
      return {ok: false, reason: 'device_busy'}
    }
    await rm(tombstone, {recursive: true, force: true}).catch(() => undefined)
  }
  return {ok: false, reason: 'device_busy'}
}

/** Record the detached device process so a later host never reclaims while it may still act. */
export async function recordDeviceProcess(lock: DeviceLock, devicePid: number): Promise<void> {
  await writeFile(join(lock.path, OWNER), JSON.stringify({taskId: lock.taskId, hostPid: process.pid, devicePid}), {mode: 0o600})
}

/** Retain the lock after an unconfirmed device effect; only manual recovery removes it. */
export async function quarantineDeviceLock(lock: DeviceLock, code: string): Promise<void> {
  await writeFile(join(lock.path, QUARANTINE), JSON.stringify({taskId: lock.taskId, code}), {mode: 0o600}).catch(() => undefined)
}

/** Releasing is best effort and never removes a lock this task no longer owns. */
export async function releaseDeviceLock(lock: DeviceLock): Promise<boolean> {
  try {
    if (record(JSON.parse(await readFile(join(lock.path, OWNER), 'utf8'))).taskId !== lock.taskId) return false
  } catch {
    return false
  }
  await unlink(join(lock.path, OWNER)).catch(() => undefined)
  try {
    await rmdir(lock.path)
    return true
  } catch {
    return false
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
