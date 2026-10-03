/** Fixed ADB operations. No model-provided shell, intents, or automatic device selection. */
import {execFile} from 'node:child_process'
import {constants} from 'node:fs'
import {access, realpath} from 'node:fs/promises'
import {delimiter, isAbsolute, join} from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'

const exec = promisify(execFile)
const keyboard = 'com.android.adbkeyboard/.AdbIME'
const refusal = /INJECT_EVENTS|SecurityException|Permission Denial/u
const failureText = /Error:|Exception occurred/u

/** Resolve once at bind time so a later PATH change cannot swap the binary that receives approved writes. */
async function resolveAdb(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    try {
      const candidate = join(directory, 'adb')
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('invalid_configuration')
}

export async function createAndroidDevice(serial: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(serial)) throw new Error('invalid_configuration')
  const adb = await resolveAdb()
  const command = async (args: string[], write = false): Promise<Buffer> => {
    if (!write && signal.aborted) throw new Error('cancelled')
    let result: {stdout: Buffer; stderr: Buffer}
    try {
      result = await exec(adb, ['-s', serial, ...args], {encoding: 'buffer', timeout: 10_000,
        maxBuffer: 32 * 1024 * 1024, ...(write ? {} : {signal})})
    } catch (error) {
      const failure = error as {stderr?: Buffer}
      if (refusal.test(failure.stderr?.toString() ?? '')) throw new Error('needs_user_action')
      // A disconnected adb client cannot establish whether the remote write completed.
      if (write) throw new Error('cleanup_unknown')
      throw new Error(signal.aborted ? 'cancelled' : 'action_failed')
    }
    const stderr = result.stderr.toString()
    if (refusal.test(stderr) || failureText.test(stderr)) {
      // adb exited 0, so the device may have applied the write despite the error text.
      if (write) throw new Error('cleanup_unknown')
      throw new Error(refusal.test(stderr) ? 'needs_user_action' : 'action_failed')
    }
    return result.stdout
  }

  const text = async (args: string[], write = false) => (await command(args, write)).toString().trim()
  const hardwareId = async () => {
    const id = await text(['shell', 'getprop', 'ro.serialno']) || await text(['shell', 'getprop', 'ro.boot.serialno'])
    if (!/^[\x21-\x7e]{1,128}$/u.test(id)) throw new Error('invalid_configuration')
    return id
  }
  if (await text(['get-state']) !== 'device') throw new Error('invalid_configuration')
  // The transport serial can be reassigned (e.g. emulator ports); writes stay bound to the hardware seen at bind.
  const boundHardware = await hardwareId()
  const verify = async () => {
    if (await text(['get-state']) !== 'device' || await hardwareId() !== boundHardware) throw new Error('invalid_configuration')
  }
  const foreground = async () => {
    const windows = await text(['shell', 'dumpsys', 'window'])
    const focused = windows.split('\n').find(line => line.includes('mCurrentFocus=')) ?? ''
    const bundle = (/\b([A-Za-z][A-Za-z0-9_.]*)\/[A-Za-z0-9_.$]+/u.exec(focused))?.[1]
    if (!bundle) throw new Error('action_failed')
    return {bundle, context: focused.trim()}
  }
  const capture = async () => {
    await verify()
    const {bundle, context} = await foreground()
    const png = await command(['exec-out', 'screencap', '-p'])
    if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.length < 24) throw new Error('action_failed')
    if ((await foreground()).context !== context) throw new Error('screen_changed')
    return {image: `data:image/png;base64,${png.toString('base64')}`, bundle, context,
      width: png.readUInt32BE(16), height: png.readUInt32BE(20)}
  }
  const initial = await capture()
  const size = {width: initial.width, height: initial.height}
  const stableCapture = async () => {
    const frame = await capture()
    if (frame.width !== initial.width || frame.height !== initial.height) throw new Error('screen_changed')
    return frame
  }

  const coordinate = (value: unknown, limit: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= limit) throw new Error('needs_user_action')
    return String(value)
  }
  return {verify, capture: stableCapture, size, perform: async (name: string, params: Record<string, unknown>) => {
    if (signal.aborted) throw new Error('cancelled')
    await verify()
    if (signal.aborted) throw new Error('cancelled')
    switch (name) {
      case 'Tap':
        await command(['shell', 'input', 'tap', coordinate(params.x, size.width), coordinate(params.y, size.height)], true)
        break
      case 'Swipe':
        await command(['shell', 'input', 'swipe', coordinate(params.fromX, size.width), coordinate(params.fromY, size.height),
          coordinate(params.toX, size.width), coordinate(params.toY, size.height), '500'], true)
        break
      case 'Home': case 'Back':
        await command(['shell', 'input', 'keyevent', name === 'Home' ? '3' : '4'], true)
        break
      case 'Launch': {
        const app = params.packageName
        if (typeof app !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(app)) throw new Error('needs_user_action')
        const component = await text(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', app])
        const activity = component.split('\n').at(-1) ?? ''
        if (!activity.startsWith(`${app}/`) || !/^[A-Za-z0-9_.$/]+$/u.test(activity)) throw new Error('needs_user_action')
        if (signal.aborted) throw new Error('cancelled')
        const result = await text(['shell', 'am', 'start', '-W', '-n', activity], true)
        if (/Error:|Exception/u.test(result)) throw new Error('action_failed')
        break
      }
      case 'Type': {
        const value = params.text
        if (typeof value !== 'string' || !value || value.length > 4000) throw new Error('needs_user_action')
        const previous = await text(['shell', 'settings', 'get', 'secure', 'default_input_method'])
        if (!/^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/u.test(previous)) throw new Error('invalid_configuration')
        if (!(await text(['shell', 'ime', 'list', '-s'])).split('\n').includes(keyboard)) throw new Error('needs_user_action')
        try {
          if (signal.aborted) throw new Error('cancelled')
          await command(['shell', 'ime', 'set', keyboard], true)
          const deadline = Date.now() + 5000
          for (;;) {
            const binding = (await text(['shell', 'dumpsys', 'input_method'])).split('\n')
              .find(line => line.includes('mCurId='))?.trim().split(/\s+/u) ?? []
            if ([`mCurId=${keyboard}`, 'mHaveConnection=true', 'mBoundToMethod=true'].every(field => binding.includes(field))) break
            if (Date.now() >= deadline) throw new Error('needs_user_action')
            await delay(100)
          }
          if (signal.aborted) throw new Error('cancelled')
          const result = await text(['shell', 'am', 'broadcast', '-p', 'com.android.adbkeyboard', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(value).toString('base64')], true)
          if (!result.includes('Broadcast completed')) throw new Error('action_failed')
        } finally {
          // Restore the original keyboard even after cancellation; uncertain restoration quarantines the device.
          try { await command(['shell', 'ime', 'set', previous], true) } catch { throw new Error('cleanup_unknown') }
        }
        break
      }
      default: throw new Error('needs_user_action')
    }
  }}
}
