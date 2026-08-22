import {snapshotJsonValue} from './codex-safe-json.js'

export const MAX_JSONL_LINE = 256 * 1024
export const MAX_STDOUT = 2 * 1024 * 1024
export const MAX_REQUEST = 64 * 1024
export const MAX_FINAL_TEXT_INPUT = 65_536
export const MAX_INTERNAL_ACTIVITY = 1_048_576
export const WORKING_INTERVAL = 30
export const SUMMARY_PROSE_LIMIT = 240

export class CodexProtocolError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'CodexProtocolError'
    this.code = code
  }
}

export class AppServerRequestRejected extends CodexProtocolError {
  readonly server_code: number

  constructor(serverCode: number) {
    super('server_rejected')
    this.name = 'AppServerRequestRejected'
    this.server_code = serverCode
  }
}

export interface JsonRpcConnectionOptions {
  readonly write: (bytes: Uint8Array) => Promise<void>
  readonly onBufferAllocate?: (bytes: number) => void
  readonly onBufferCopy?: (bytes: number) => void
  readonly onNotification?: (notification: {
    readonly method: string
    readonly params: Readonly<Record<string, unknown>>
  }) => void
  readonly onServerRequest?: (method: string) => void
}

export interface JsonRpcRequestOptions {
  readonly onWritten?: (requestId: number) => void
  readonly signal?: AbortSignal
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  active: boolean
}

const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder('utf-8', {fatal: true})
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayTag = Reflect.get(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag) ?? {},
  'get',
) as ((this: unknown) => unknown) | undefined

export class JsonRpcConnection {
  readonly #write: (bytes: Uint8Array) => Promise<void>
  readonly #onNotification: JsonRpcConnectionOptions['onNotification']
  readonly #onServerRequest: JsonRpcConnectionOptions['onServerRequest']
  readonly #onBufferAllocate: JsonRpcConnectionOptions['onBufferAllocate']
  readonly #onBufferCopy: JsonRpcConnectionOptions['onBufferCopy']
  readonly #pending = new Map<number, PendingRequest>()
  readonly #input: SegmentedByteQueue
  readonly #lineBuffer: Uint8Array
  #nextId = 0
  #writer = Promise.resolve()
  #drainPromise: Promise<void> | undefined
  #lineBytes = 0
  #stdoutBytes = 0
  #failure: CodexProtocolError | undefined
  #ended = false

  constructor(options: JsonRpcConnectionOptions) {
    this.#write = options.write
    this.#onNotification = options.onNotification
    this.#onServerRequest = options.onServerRequest
    this.#onBufferAllocate = options.onBufferAllocate
    this.#onBufferCopy = options.onBufferCopy
    this.#lineBuffer = new Uint8Array(MAX_JSONL_LINE)
    this.#noteBufferAllocate(MAX_JSONL_LINE)
    this.#input = new SegmentedByteQueue(
      bytes => { this.#noteBufferAllocate(bytes) },
      bytes => { this.#noteBufferCopy(bytes) },
    )
  }

  get pendingRequestIds(): readonly number[] {
    return [...this.#pending.entries()]
      .filter(([, pending]) => pending.active)
      .map(([requestId]) => requestId)
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    return await this.#request(method, () => params, options)
  }

  async requestPrepared(
    method: string,
    prepare: () => Readonly<Record<string, unknown>>,
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    return await this.#request(method, prepare, options)
  }

  async #request(
    method: string,
    prepare: () => Readonly<Record<string, unknown>>,
    options: JsonRpcRequestOptions,
  ): Promise<unknown> {
    this.#raiseIfFailed()
    if (options.signal?.aborted === true) throw abortError()
    let resolveResponse!: (value: unknown) => void
    let rejectResponse!: (error: Error) => void
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    void response.catch(() => undefined)
    await this.#serializeWrite(async () => {
      this.#raiseIfFailed()
      if (options.signal?.aborted === true) throw abortError()
      let params: Readonly<Record<string, unknown>>
      try {
        params = prepare()
      } catch (error) {
        if (error instanceof CodexProtocolError) throw error
        throw new CodexProtocolError('invalid_request')
      }
      const requestId = this.#nextId + 1
      const bytes = encodeMessage({method, id: requestId, params})
      this.#nextId = requestId
      let onAbort: (() => void) | undefined
      const pending: PendingRequest = {
        resolve: resolveResponse,
        reject: rejectResponse,
        signal: options.signal,
        onAbort,
        active: true,
      }
      if (options.signal !== undefined) {
        onAbort = () => {
          if (!pending.active) return
          pending.active = false
          pending.reject(abortError())
        }
        pending.onAbort = onAbort
        options.signal.addEventListener('abort', onAbort, {once: true})
      }
      this.#pending.set(requestId, pending)
      try {
        await this.#write(bytes)
      } catch {
        this.#discardPending(requestId)
        const failure = this.#poison(new CodexProtocolError('stream_failure'))
        throw failure
      }
      try {
        options.onWritten?.(requestId)
      } catch {
        // The transport write already crossed the side-effect boundary. An observer is diagnostic
        // only and cannot make the request disappear or copy request data into a public failure.
      }
    })
    return await response
  }

  async notify(method: string, params?: Readonly<Record<string, unknown>>): Promise<void> {
    this.#raiseIfFailed()
    await this.#serializeWrite(async () => {
      this.#raiseIfFailed()
      const bytes = encodeMessage(params === undefined ? {method} : {method, params})
      try {
        await this.#write(bytes)
      } catch {
        throw this.#poison(new CodexProtocolError('stream_failure'))
      }
    })
  }

  feed(chunk: Uint8Array): Promise<void> {
    try {
      this.#raiseIfFailed()
      if (this.#ended) throw this.#failure ?? new CodexProtocolError('transport_lost')
      if (!isUint8Array(chunk)) throw this.#poison(new CodexProtocolError('malformed_jsonl'))
      const capacity = Math.max(0, MAX_STDOUT + 1 - this.#stdoutBytes - this.#input.byteLength)
      this.#input.append(chunk, capacity)
      if (this.#drainPromise !== undefined) return this.#drainPromise
      const shared = Promise.resolve().then(async () => { await this.#ownInputDrain() })
      this.#drainPromise = shared
      return shared
    } catch (error) {
      const failure = error instanceof CodexProtocolError
        ? this.#poison(error)
        : this.#poison(new CodexProtocolError('malformed_jsonl'))
      return Promise.reject(failure)
    }
  }

  end(): CodexProtocolError | undefined {
    if (this.#ended) return this.#failure
    this.#ended = true
    if (this.#failure !== undefined) return this.#failure
    if (this.#lineBytes > 0 || this.#input.byteLength > 0) {
      return this.#poison(new CodexProtocolError('malformed_jsonl'))
    }
    if ([...this.#pending.values()].some(pending => pending.active)) {
      return this.#poison(new CodexProtocolError('transport_lost'))
    }
    for (const requestId of this.#pending.keys()) this.#discardPending(requestId)
    return undefined
  }

  async #route(message: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id')) {
      const method = message.method
      if (typeof method !== 'string') throw this.#poison(new CodexProtocolError('malformed_jsonl'))
      try {
        this.#onServerRequest?.(method)
      } catch {
        // Observers do not own the protocol reader.
      }
      await this.#serializeWrite(async () => {
        this.#raiseIfFailed()
        try {
          await this.#write(encodeMessage({
            id: message.id,
            error: {code: -32601, message: 'Method not implemented'},
          }))
        } catch {
          throw this.#poison(new CodexProtocolError('stream_failure'))
        }
      })
      return
    }
    if (Object.hasOwn(message, 'method')) {
      const keys = Object.keys(message)
      const method = message.method
      const params = Object.hasOwn(message, 'params') ? message.params : {}
      const emittedAtMs = Object.hasOwn(message, 'emittedAtMs') ? message.emittedAtMs : undefined
      const allowedKeys = new Set(['method', 'params', 'emittedAtMs'])
      if (
        typeof method !== 'string'
        || !isPlainObject(params)
        || keys.some(key => !allowedKeys.has(key))
        || (Object.hasOwn(message, 'emittedAtMs') && (
          typeof emittedAtMs !== 'number'
          || !Number.isSafeInteger(emittedAtMs)
          || emittedAtMs < 0
        ))
      ) {
        throw this.#poison(new CodexProtocolError('malformed_jsonl'))
      }
      try {
        this.#onNotification?.({method, params})
      } catch {
        // A consumer cannot take down framing or reveal an unknown payload via its exception.
      }
      return
    }
    if (Object.hasOwn(message, 'id')) {
      const requestId = message.id
      if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId)) {
        throw this.#poison(new CodexProtocolError('malformed_jsonl'))
      }
      const pending = this.#pending.get(requestId)
      if (pending === undefined) throw this.#poison(new CodexProtocolError('unknown_response_id'))
      this.#discardPending(requestId, false)
      if (!pending.active) return
      pending.active = false
      const keys = Object.keys(message)
      if (keys.length === 2 && Object.hasOwn(message, 'result')) {
        pending.resolve(message.result)
        return
      }
      if (keys.length === 2 && isPlainObject(message.error)) {
        const remoteCode = message.error.code
        const serverCode = typeof remoteCode === 'number' && Number.isSafeInteger(remoteCode)
          ? remoteCode
          : -32000
        pending.reject(new AppServerRequestRejected(serverCode))
        return
      }
      const failure = this.#poison(new CodexProtocolError('malformed_jsonl'))
      pending.reject(failure)
      throw failure
    }
    throw this.#poison(new CodexProtocolError('malformed_jsonl'))
  }

  async #drainInput(): Promise<void> {
    while (this.#input.byteLength > 0) {
      this.#raiseIfFailed()
      if (this.#ended) throw this.#failure ?? new CodexProtocolError('transport_lost')
      if (this.#stdoutBytes === MAX_STDOUT) throw new CodexProtocolError('stdout_too_large')
      if (this.#lineBytes === MAX_JSONL_LINE) {
        throw new CodexProtocolError('stdout_line_too_large')
      }
      const next = this.#input.take(Math.min(
        MAX_STDOUT - this.#stdoutBytes,
        MAX_JSONL_LINE - this.#lineBytes,
      ))
      this.#lineBuffer.set(next.bytes, this.#lineBytes)
      this.#noteBufferCopy(next.bytes.byteLength)
      this.#lineBytes += next.bytes.byteLength
      this.#stdoutBytes += next.bytes.byteLength
      if (!next.endsLine) continue
      const message = decodeMessage(this.#lineBuffer.subarray(0, this.#lineBytes))
      this.#lineBytes = 0
      await this.#route(message)
    }
  }

  async #ownInputDrain(): Promise<void> {
    try {
      while (this.#input.byteLength > 0) await this.#drainInput()
    } catch (error) {
      if (error instanceof CodexProtocolError) throw this.#poison(error)
      throw this.#poison(new CodexProtocolError('stream_failure'))
    } finally {
      this.#drainPromise = undefined
    }
  }

  #noteBufferCopy(bytes: number): void {
    try {
      this.#onBufferCopy?.(bytes)
    } catch {
      // Diagnostics cannot own protocol state.
    }
  }

  #noteBufferAllocate(bytes: number): void {
    try {
      this.#onBufferAllocate?.(bytes)
    } catch {
      // Diagnostics cannot own protocol state.
    }
  }

  #serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#writer.then(operation)
    this.#writer = task.then(() => undefined, () => undefined)
    return task
  }

  #discardPending(requestId: number, deactivate = true): void {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    this.#pending.delete(requestId)
    if (deactivate) pending.active = false
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
  }

  #raiseIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure
    if (this.#ended) throw new CodexProtocolError('transport_lost')
  }

  #poison(failure: CodexProtocolError): CodexProtocolError {
    if (this.#failure !== undefined) return this.#failure
    this.#failure = failure
    for (const [requestId, pending] of this.#pending) {
      const wasActive = pending.active
      this.#discardPending(requestId)
      if (wasActive) pending.reject(failure)
    }
    return failure
  }
}

function encodeMessage(message: unknown): Uint8Array {
  try {
    const rendered = JSON.stringify(snapshotJsonValue(message))
    if (rendered === undefined) throw new TypeError('not JSON')
    const bytes = encoder.encode(`${rendered}\n`)
    if (bytes.byteLength > MAX_REQUEST) throw new CodexProtocolError('request_too_large')
    return bytes
  } catch (error) {
    if (error instanceof CodexProtocolError) throw error
    throw new CodexProtocolError('invalid_request')
  }
}

function decodeMessage(line: Uint8Array): Record<string, unknown> {
  try {
    const text = fatalDecoder.decode(line.subarray(0, line.byteLength - 1))
    const value = JSON.parse(text) as unknown
    if (!isPlainObject(value) || Object.keys(value).length === 0) throw new TypeError('invalid')
    assertDecodedNumbers(value)
    return value
  } catch {
    throw new CodexProtocolError('malformed_jsonl')
  }
}

function assertDecodedNumbers(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('invalid number')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertDecodedNumbers(item)
    return
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertDecodedNumbers(item)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function isUint8Array(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || typedArrayTag === undefined) return false
  try {
    return Reflect.apply(typedArrayTag, value, []) === 'Uint8Array'
  } catch {
    return false
  }
}


const INPUT_SLAB_BYTES = 4096

interface InputSlab {
  readonly bytes: Uint8Array
  read: number
  used: number
}

class SegmentedByteQueue {
  readonly #onAllocate: (bytes: number) => void
  readonly #onCopy: (bytes: number) => void
  #slabs: InputSlab[] = []
  #head = 0
  #byteLength = 0

  constructor(onAllocate: (bytes: number) => void, onCopy: (bytes: number) => void) {
    this.#onAllocate = onAllocate
    this.#onCopy = onCopy
  }

  get byteLength(): number {
    return this.#byteLength
  }

  append(source: Uint8Array, maximum: number): void {
    const accepted = Math.min(source.byteLength, maximum)
    let offset = 0
    while (offset < accepted) {
      let tail = this.#slabs.at(-1)
      if (tail === undefined || tail.used === tail.bytes.byteLength) {
        tail = {bytes: new Uint8Array(INPUT_SLAB_BYTES), read: 0, used: 0}
        this.#onAllocate(INPUT_SLAB_BYTES)
        this.#slabs.push(tail)
      }
      const count = Math.min(accepted - offset, tail.bytes.byteLength - tail.used)
      tail.bytes.set(source.subarray(offset, offset + count), tail.used)
      tail.used += count
      offset += count
      this.#byteLength += count
      this.#onCopy(count)
    }
  }

  take(maximum: number): {readonly bytes: Uint8Array; readonly endsLine: boolean} {
    const slab = this.#slabs[this.#head]
    if (slab === undefined || maximum <= 0) throw new TypeError('empty input queue')
    const available = Math.min(slab.used - slab.read, maximum)
    const candidate = slab.bytes.subarray(slab.read, slab.read + available)
    const newline = candidate.indexOf(0x0a)
    const count = newline < 0 ? candidate.byteLength : newline + 1
    const bytes = candidate.subarray(0, count)
    slab.read += count
    this.#byteLength -= count
    if (slab.read === slab.used) {
      this.#head += 1
      if (this.#byteLength === 0) {
        slab.read = 0
        slab.used = 0
        this.#slabs = [slab]
        this.#head = 0
      }
    }
    return {bytes, endsLine: newline >= 0}
  }
}

function abortError(): Error {
  const error = new Error('request aborted')
  error.name = 'AbortError'
  return error
}
