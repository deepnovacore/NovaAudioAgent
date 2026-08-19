import { closeSync, openSync, writeSync } from 'node:fs'
import type { Clock } from '../clock.js'
import { jsonValueSchema, type JsonValue } from '../events.js'

export interface RealtimeTelemetry {
  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void
  close(): void
}

export class NullTelemetry implements RealtimeTelemetry {
  record(_kind: string, _payload: Readonly<Record<string, JsonValue>>): void {
    void _kind
    void _payload
    return
  }

  close(): void {
    return
  }
}

export class JsonlTelemetry implements RealtimeTelemetry, Disposable {
  readonly #clock: Clock
  readonly #fileDescriptor: number
  #closed = false

  constructor(path: string, options: {readonly clock: Clock}) {
    this.#clock = options.clock
    this.#fileDescriptor = openSync(path, 'w')
  }

  record(kind: string, payload: Readonly<Record<string, JsonValue>>): void {
    if (this.#closed) throw new Error('telemetry writer is closed')
    const safePayload = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, jsonValueSchema.parse(value)]),
    )
    const record = jsonValueSchema.parse({ts: this.#clock.now(), kind, payload: safePayload})
    writeSync(this.#fileDescriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8')
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
