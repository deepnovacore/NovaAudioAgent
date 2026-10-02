/** One canonical lock per physical device, shared by every phone engine. */
import {createHash} from 'node:crypto'
import {mkdir, readFile, rmdir, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export interface DeviceLock { readonly path: string; readonly taskId: string }

/** A Simulator reached as `ios` or `ios-simulator` is the same handset for ownership purposes. */
export function deviceLockPath(lockRoot: string, deviceType: string, deviceId: string): string {
  const platform = deviceType === 'ios-simulator' ? 'ios' : deviceType
  return join(lockRoot, createHash('sha256').update(`${platform}:${deviceId}`).digest('hex'))
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A live process owned by someone else still holds the device.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function acquireDeviceLock(lockRoot: string, deviceType: string, deviceId: string, taskId: string):
Promise<{ok: true; lock: DeviceLock} | {ok: false; reason: 'device_busy' | 'device_lock_failed'}> {
  const path = deviceLockPath(lockRoot, deviceType, deviceId)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path, {mode: 0o700})
      try {
        await writeFile(join(path, 'owner.json'), JSON.stringify({taskId, hostPid: process.pid}), {mode: 0o600, flag: 'wx'})
      } catch {
        await rmdir(path).catch(() => undefined)
        return {ok: false, reason: 'device_lock_failed'}
      }
      return {ok: true, lock: {path, taskId}}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return {ok: false, reason: 'device_lock_failed'}
    }
    // A lock owned by a dead host is a crash remnant; an unreadable one is never reclaimed.
    try {
      const owner = record(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')))
      const pid = owner.hostPid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || ownerAlive(pid)) return {ok: false, reason: 'device_busy'}
      await unlink(join(path, 'owner.json')).catch(() => undefined)
      await rmdir(path)
    } catch {
      return {ok: false, reason: 'device_busy'}
    }
  }
  return {ok: false, reason: 'device_busy'}
}

/** Releasing is best effort: a retained lock must never replace the run result. */
export async function releaseDeviceLock(lock: DeviceLock): Promise<boolean> {
  await unlink(join(lock.path, 'owner.json')).catch(() => undefined)
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
