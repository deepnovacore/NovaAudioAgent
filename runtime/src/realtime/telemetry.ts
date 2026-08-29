import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type { Clock } from '../clock.js'
import { jsonValueSchema, type JsonValue } from '../events.js'

export interface RealtimeTelemetry {
  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void
  diagnostics?(): RealtimeDiagnosticsSnapshot
  close(): void
}

export const MAX_REALTIME_DIAGNOSTICS = 128
const MAX_DIAGNOSTIC_STRING_CHARS = 256
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 16
const MAX_DIAGNOSTIC_OBJECT_KEYS = 32
const MAX_DIAGNOSTIC_DEPTH = 4
const DIAGNOSTIC_BODY_KEY = /(?:^|_)(?:body|content|prompt|query|summary|text|transcript|work_order|arguments)(?:_|$)/iu

export interface RealtimeDiagnosticRecord {
  readonly ts: number
  readonly kind: string
  readonly payload: Readonly<Record<string, JsonValue>>
}

export interface RealtimeDiagnosticsSnapshot {
  readonly version: 1
  readonly records: readonly RealtimeDiagnosticRecord[]
}

class RealtimeDiagnosticRing {
  readonly #clock: Clock
  readonly #records: RealtimeDiagnosticRecord[] = []

  constructor(clock: Clock) {
    this.#clock = clock
  }

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    const safePayload = diagnosticObject(payload, 0)
    this.#records.push(Object.freeze({
      ts: this.#clock.now(),
      kind: sliceCodePoints(kind, MAX_DIAGNOSTIC_STRING_CHARS),
      payload: safePayload,
    }))
    while (this.#records.length > MAX_REALTIME_DIAGNOSTICS) this.#records.shift()
  }

  snapshot(): RealtimeDiagnosticsSnapshot {
    return Object.freeze({version: 1, records: Object.freeze([...this.#records])})
  }
}

export class NullTelemetry implements RealtimeTelemetry {
  readonly #diagnostics: RealtimeDiagnosticRing

  constructor(options: {readonly clock?: Clock} = {}) {
    this.#diagnostics = new RealtimeDiagnosticRing(options.clock ?? {
      now: () => Date.now() / 1_000,
      sleep: () => Promise.resolve(),
    })
  }

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    const safePayload = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, jsonValueSchema.parse(value)]),
    )
    this.#diagnostics.record(kind, safePayload)
  }

  diagnostics(): RealtimeDiagnosticsSnapshot {
    return this.#diagnostics.snapshot()
  }

  close(): void {
    return
  }
}

export class JsonlTelemetry implements RealtimeTelemetry, Disposable {
  readonly #clock: Clock
  readonly #diagnostics: RealtimeDiagnosticRing
  readonly #fileDescriptor: number
  #closed = false

  constructor(path: string, options: {readonly clock: Clock}) {
    this.#clock = options.clock
    this.#diagnostics = new RealtimeDiagnosticRing(options.clock)
    const fileDescriptor = openSync(path, 'w', 0o600)
    try {
      // `mode` applies only when a file is created. Reused debug paths must not retain a looser
      // permission from an older client; Windows does not expose POSIX owner bits.
      if (process.platform !== 'win32') fchmodSync(fileDescriptor, 0o600)
    } catch (cause) {
      closeSync(fileDescriptor)
      throw cause
    }
    this.#fileDescriptor = fileDescriptor
  }

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    if (this.#closed) throw new Error('telemetry writer is closed')
    const safePayload = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, jsonValueSchema.parse(value)]),
    )
    const record = jsonValueSchema.parse({ts: this.#clock.now(), kind, payload: safePayload})
    writeSync(this.#fileDescriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8')
    this.#diagnostics.record(kind, safePayload)
  }

  diagnostics(): RealtimeDiagnosticsSnapshot {
    return this.#diagnostics.snapshot()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.#fileDescriptor)
  }

  [Symbol.dispose](): void {
    this.close()
  }
}

/** Use the documented source-runtime path without creating telemetry by default. */
export function createRealtimeTelemetry(
  environment: Readonly<Record<string, string | undefined>>,
  options: {readonly clock: Clock; readonly homeDirectory?: string},
): RealtimeTelemetry {
  const configured = environment.NOVA_AUDIO_AGENT_REALTIME_TELEMETRY?.trim() ?? ''
  if (configured === '') return new NullTelemetry({clock: options.clock})
  const homeDirectory = options.homeDirectory ?? homedir()
  const path = configured === '~'
    ? homeDirectory
    : configured.startsWith('~/') ? join(homeDirectory, configured.slice(2)) : configured
  return new JsonlTelemetry(path, {clock: options.clock})
}

function diagnosticObject(
  value: Readonly<Record<string, JsonValue>>,
  depth: number,
): Readonly<Record<string, JsonValue>> {
  const result: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)) {
    if (DIAGNOSTIC_BODY_KEY.test(key)) continue
    result[sliceCodePoints(key, MAX_DIAGNOSTIC_STRING_CHARS)] = diagnosticValue(child, depth + 1)
  }
  return Object.freeze(result)
}

function diagnosticValue(value: JsonValue, depth: number): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return sliceCodePoints(value, MAX_DIAGNOSTIC_STRING_CHARS)
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return null
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS).map(child => (
      diagnosticValue(child, depth + 1)
    ))
    Object.freeze(result)
    return result
  }
  return diagnosticObject(value, depth)
}

function sliceCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}
