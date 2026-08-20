import {CodexProtocolError, MAX_INTERNAL_ACTIVITY} from './codex-protocol.js'

export const MAX_LINE_BYTES = 64 * 1024
export const MAX_STDOUT_BYTES = 1024 * 1024

const fatalDecoder = new TextDecoder('utf-8', {fatal: true})
const MILESTONES = new Set([
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
])
const ITEM_EVENTS = new Set(['item.started', 'item.updated', 'item.completed'])

export class CodexJsonlProtocolError extends CodexProtocolError {
  constructor(code: string) {
    super(code)
    this.name = 'CodexJsonlProtocolError'
  }
}

export interface CodexJsonlSummary {
  readonly events: readonly Readonly<Record<string, unknown>>[]
  readonly thread_started: boolean
  readonly turn_started: boolean
  readonly terminal: 'completed' | 'failed' | null
  readonly transport_closed: boolean
  readonly unknown_event_count: number
  readonly internal_activity_count: number
}

export class CodexJsonlParser {
  static readonly MAX_LINE_BYTES = MAX_LINE_BYTES
  static readonly MAX_STDOUT_BYTES = MAX_STDOUT_BYTES

  readonly #events: Readonly<Record<string, unknown>>[] = []
  #threadStarted = false
  #turnStarted = false
  #terminal: 'completed' | 'failed' | null = null
  #transportClosed = false
  #unknownEventCount = 0
  #internalActivityCount = 0
  #stdoutBytes = 0

  feed(line: Uint8Array): void {
    if (this.#transportClosed) throw new CodexJsonlProtocolError('transport_closed')
    if (!(line instanceof Uint8Array)) throw new CodexJsonlProtocolError('malformed_jsonl')
    if (line.byteLength > MAX_LINE_BYTES) throw new CodexJsonlProtocolError('line_too_large')
    if (this.#stdoutBytes + line.byteLength > MAX_STDOUT_BYTES) {
      throw new CodexJsonlProtocolError('stdout_too_large')
    }
    this.#stdoutBytes += line.byteLength
    let event: unknown
    try {
      event = JSON.parse(fatalDecoder.decode(line)) as unknown
      assertSafeNumbers(event)
    } catch {
      throw new CodexJsonlProtocolError('malformed_jsonl')
    }
    if (!isPlainObject(event) || Object.keys(event).length === 0) {
      throw new CodexJsonlProtocolError('invalid_event')
    }
    const eventType = event.type
    if (typeof eventType !== 'string') throw new CodexJsonlProtocolError('invalid_event_type')
    if (ITEM_EVENTS.has(eventType)) {
      if (!this.#turnStarted || this.#terminal !== null) {
        throw new CodexJsonlProtocolError('item_outside_turn')
      }
      if (this.#internalActivityCount < MAX_INTERNAL_ACTIVITY) this.#internalActivityCount += 1
      return
    }
    if (!MILESTONES.has(eventType)) {
      if (this.#unknownEventCount < MAX_INTERNAL_ACTIVITY) this.#unknownEventCount += 1
      return
    }
    if (eventType === 'thread.started') {
      if (this.#threadStarted) throw new CodexJsonlProtocolError('duplicate_thread')
      if (this.#turnStarted || this.#terminal !== null) {
        throw new CodexJsonlProtocolError('thread_out_of_order')
      }
      this.#threadStarted = true
    } else if (eventType === 'turn.started') {
      if (!this.#threadStarted) throw new CodexJsonlProtocolError('turn_before_thread')
      if (this.#turnStarted || this.#terminal !== null) {
        throw new CodexJsonlProtocolError('duplicate_turn')
      }
      this.#turnStarted = true
    } else if (eventType === 'turn.completed') {
      this.#requireActiveTurnForTerminal()
      this.#appendInternalActivity()
      this.#terminal = 'completed'
    } else if (eventType === 'turn.failed') {
      this.#requireActiveTurnForTerminal()
      this.#appendInternalActivity()
      this.#terminal = 'failed'
    }
    this.#events.push(Object.freeze({type: eventType}))
  }

  close(): CodexJsonlSummary {
    if (this.#transportClosed) throw new CodexJsonlProtocolError('transport_closed')
    this.#transportClosed = true
    if (this.#terminal === null) throw new CodexJsonlProtocolError('missing_terminal')
    return Object.freeze({
      events: Object.freeze([...this.#events]),
      thread_started: this.#threadStarted,
      turn_started: this.#turnStarted,
      terminal: this.#terminal,
      transport_closed: true,
      unknown_event_count: this.#unknownEventCount,
      internal_activity_count: this.#internalActivityCount,
    })
  }

  #appendInternalActivity(): void {
    if (this.#internalActivityCount === 0) return
    this.#events.push(Object.freeze({
      type: 'internal_activity', count: this.#internalActivityCount,
    }))
  }

  #requireActiveTurnForTerminal(): void {
    if (this.#terminal !== null) throw new CodexJsonlProtocolError('duplicate_terminal')
    if (!this.#turnStarted) throw new CodexJsonlProtocolError('terminal_without_turn')
  }
}

function assertSafeNumbers(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('unsafe number')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeNumbers(item)
    return
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertSafeNumbers(item)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
