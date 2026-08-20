import {closeSync, openSync, readSync, realpathSync, statSync} from 'node:fs'
import {isAbsolute} from 'node:path'

import {snapshotJsonRecord} from './codex-safe-json.js'

export const WINDOWS_GUARDIAN_FRAME_LIMIT = 4096
export const WINDOWS_GUARDIAN_READY_TIMEOUT_MS = 5000

export type WindowsGuardianFrame = Readonly<
  | {type: 'ready'; version: 1; targetPid: number}
  | {type: 'exit'; version: 1; leaderExitCode: number | null; treeEmpty: true}
>

const fatalDecoder = new TextDecoder('utf-8', {fatal: true})
const encoder = new TextEncoder()
const windowsHelperBrand: unique symbol = Symbol('WindowsGuardianHelper')
export interface WindowsGuardianHelper { readonly [windowsHelperBrand]: true }
const helperPaths = new WeakMap<WindowsGuardianHelper, string>()

export class CodexWindowsGuardianError extends Error {
  readonly code = 'spawn_failed' as const

  constructor() {
    super('spawn_failed')
    this.name = 'CodexWindowsGuardianError'
  }
}

export class WindowsGuardianControlParser {
  #buffer = new Uint8Array(WINDOWS_GUARDIAN_FRAME_LIMIT + 1)
  #used = 0
  #state: 'waiting_ready' | 'waiting_exit' | 'complete' | 'failed' = 'waiting_ready'

  feed(chunk: Uint8Array): readonly WindowsGuardianFrame[] {
    try {
      if (this.#state === 'failed' || this.#state === 'complete') throw new CodexWindowsGuardianError()
      if (!isUint8Array(chunk)) throw new CodexWindowsGuardianError()
      const result: WindowsGuardianFrame[] = []
      for (const byte of chunk) {
        if (byte === 0x0a) {
          if (this.#used === 0) throw new CodexWindowsGuardianError()
          const line = this.#buffer.slice(0, this.#used)
          this.#used = 0
          const frame = this.#parseLine(line)
          result.push(frame)
          continue
        }
        if (this.#used === WINDOWS_GUARDIAN_FRAME_LIMIT) throw new CodexWindowsGuardianError()
        this.#buffer[this.#used] = byte
        this.#used += 1
      }
      return Object.freeze(result)
    } catch {
      this.#state = 'failed'
      this.#used = 0
      throw new CodexWindowsGuardianError()
    }
  }

  end(): void {
    if (this.#used !== 0 || this.#state !== 'complete') {
      this.#state = 'failed'
      this.#used = 0
      throw new CodexWindowsGuardianError()
    }
  }

  #parseLine(line: Uint8Array): WindowsGuardianFrame {
    let raw: string
    let parsed: Record<string, unknown>
    try {
      raw = fatalDecoder.decode(line)
      parsed = snapshotJsonRecord(JSON.parse(raw) as unknown)
    } catch {
      throw new CodexWindowsGuardianError()
    }
    if (topLevelColonCount(raw) !== Object.keys(parsed).length) {
      throw new CodexWindowsGuardianError()
    }
    if (this.#state === 'waiting_ready') {
      if (
        !exactKeys(parsed, ['type', 'version', 'targetPid'])
        || parsed.type !== 'ready'
        || parsed.version !== 1
        || typeof parsed.targetPid !== 'number'
        || !Number.isSafeInteger(parsed.targetPid)
        || parsed.targetPid <= 0
      ) throw new CodexWindowsGuardianError()
      this.#state = 'waiting_exit'
      return Object.freeze({type: 'ready', version: 1, targetPid: parsed.targetPid})
    }
    if (this.#state === 'waiting_exit') {
      if (
        !exactKeys(parsed, ['type', 'version', 'leaderExitCode', 'treeEmpty'])
        || parsed.type !== 'exit'
        || parsed.version !== 1
        || (
          parsed.leaderExitCode !== null
          && (typeof parsed.leaderExitCode !== 'number' || !Number.isSafeInteger(parsed.leaderExitCode))
        )
        || parsed.treeEmpty !== true
      ) throw new CodexWindowsGuardianError()
      this.#state = 'complete'
      return Object.freeze({
        type: 'exit',
        version: 1,
        leaderExitCode: parsed.leaderExitCode,
        treeEmpty: true,
      })
    }
    throw new CodexWindowsGuardianError()
  }
}

export function windowsGuardianForceFrame(): Uint8Array {
  return encoder.encode('{"type":"force","version":1}\n')
}

export function windowsGuardianHelperFromPackage(
  configuredPath: string,
  allowlistedCanonicalPaths: readonly string[],
  architecture: 'x64' | 'arm64' | 'ia32',
): WindowsGuardianHelper {
  try {
    if (
      typeof configuredPath !== 'string'
      || !isAbsolute(configuredPath)
      || !configuredPath.toLowerCase().endsWith('.exe')
      || realpathSync(configuredPath) !== configuredPath
      || !statSync(configuredPath).isFile()
      || !allowlistedCanonicalPaths.some(candidate => (
        isAbsolute(candidate) && realpathSync(candidate) === configuredPath
      ))
    ) throw new CodexWindowsGuardianError()
    validatePortableExecutable(configuredPath, architecture)
    const helper = Object.freeze({[windowsHelperBrand]: true as const})
    helperPaths.set(helper, configuredPath)
    return helper
  } catch {
    throw new CodexWindowsGuardianError()
  }
}

export function windowsGuardianHelperPath(helper: WindowsGuardianHelper): string {
  const path = helperPaths.get(helper)
  if (path === undefined) throw new CodexWindowsGuardianError()
  return path
}

/** Test-only wrapper; production owners retain the opaque helper brand. */
export function windowsGuardianHelperForTest(
  configuredPath: string,
  allowlistedCanonicalPaths: readonly string[],
  architecture: string,
): string {
  if (architecture !== 'x64' && architecture !== 'arm64' && architecture !== 'ia32') {
    throw new CodexWindowsGuardianError()
  }
  return windowsGuardianHelperPath(windowsGuardianHelperFromPackage(
    configuredPath,
    allowlistedCanonicalPaths,
    architecture,
  ))
}

function validatePortableExecutable(
  path: string,
  architecture: 'x64' | 'arm64' | 'ia32',
): void {
  const buffer = new Uint8Array(4096)
  const descriptor = openSync(path, 'r')
  let bytesRead: number
  try {
    bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0)
  } finally {
    closeSync(descriptor)
  }
  if (bytesRead < 0x86 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new CodexWindowsGuardianError()
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, bytesRead)
  const peOffset = view.getUint32(0x3c, true)
  if (
    peOffset + 6 > bytesRead
    || buffer[peOffset] !== 0x50
    || buffer[peOffset + 1] !== 0x45
    || buffer[peOffset + 2] !== 0
    || buffer[peOffset + 3] !== 0
  ) throw new CodexWindowsGuardianError()
  const expected = architecture === 'x64' ? 0x8664 : architecture === 'arm64' ? 0xaa64 : 0x014c
  if (view.getUint16(peOffset + 4, true) !== expected) throw new CodexWindowsGuardianError()
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function topLevelColonCount(raw: string): number {
  let inString = false
  let escaped = false
  let depth = 0
  let count = 0
  for (const character of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    else if (character === ':' && depth === 1) count += 1
  }
  if (inString || depth !== 0) throw new CodexWindowsGuardianError()
  return count
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value instanceof Uint8Array
}
