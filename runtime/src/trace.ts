import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import {
  eventRecordSchema,
  type EventRecord,
} from './events.js'
import { canonicalJson } from './canonical-json.js'

export { canonicalJson } from './canonical-json.js'

export class TraceWriter implements Disposable {
  readonly #descriptor: number
  #closed = false

  constructor(path: string) {
    this.#descriptor = openSync(path, 'w', 0o600)
  }

  write(event: EventRecord): void {
    if (this.#closed) throw new Error('trace writer is closed')
    const validated = eventRecordSchema.parse(event)
    writeSync(this.#descriptor, `${canonicalJson(validated)}\n`, undefined, 'utf8')
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.#descriptor)
  }

  [Symbol.dispose](): void {
    this.close()
  }
}

export function replayTrace(path: string): EventRecord[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .map(line => eventRecordSchema.parse(JSON.parse(line) as unknown))
}
