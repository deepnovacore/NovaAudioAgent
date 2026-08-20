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

export class JsonRpcConnection {
  readonly #write: (bytes: Uint8Array) => Promise<void>
  readonly #onNotification: JsonRpcConnectionOptions['onNotification']
  readonly #onServerRequest: JsonRpcConnectionOptions['onServerRequest']
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 0
  #writer = Promise.resolve()
  #reader = Promise.resolve()
  #buffer = new Uint8Array()
  #stdoutBytes = 0
  #failure: CodexProtocolError | undefined
  #ended = false

  constructor(options: JsonRpcConnectionOptions) {
    this.#write = options.write
    this.#onNotification = options.onNotification
    this.#onServerRequest = options.onServerRequest
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
    this.#raiseIfFailed()
    if (options.signal?.aborted === true) throw abortError()
    let resolveResponse!: (value: unknown) => void
    let rejectResponse!: (error: Error) => void
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    await this.#serializeWrite(async () => {
      this.#raiseIfFailed()
      if (options.signal?.aborted === true) throw abortError()
      this.#nextId += 1
      const requestId = this.#nextId
      const bytes = encodeMessage({method, id: requestId, params})
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
    const operation = this.#reader.then(async () => {
      this.#raiseIfFailed()
      if (this.#ended) throw this.#failure ?? new CodexProtocolError('transport_lost')
      if (!(chunk instanceof Uint8Array)) throw this.#poison(new CodexProtocolError('malformed_jsonl'))
      this.#stdoutBytes += chunk.byteLength
      if (this.#stdoutBytes > MAX_STDOUT) {
        throw this.#poison(new CodexProtocolError('stdout_too_large'))
      }
      this.#buffer = concatenate(this.#buffer, chunk)
      while (true) {
        const newline = this.#buffer.indexOf(0x0a)
        if (newline < 0) {
          if (this.#buffer.byteLength > MAX_JSONL_LINE) {
            throw this.#poison(new CodexProtocolError('stdout_line_too_large'))
          }
          return
        }
        const lineLength = newline + 1
        if (lineLength > MAX_JSONL_LINE) {
          throw this.#poison(new CodexProtocolError('stdout_line_too_large'))
        }
        const line = this.#buffer.slice(0, lineLength)
        this.#buffer = this.#buffer.slice(lineLength)
        await this.#route(decodeMessage(line))
      }
    })
    const task = operation.catch((error: unknown) => {
      if (error instanceof CodexProtocolError) throw this.#poison(error)
      throw this.#poison(new CodexProtocolError('stream_failure'))
    })
    this.#reader = task.catch(() => undefined)
    return task
  }

  end(): CodexProtocolError | undefined {
    if (this.#ended) return this.#failure
    this.#ended = true
    if (this.#failure !== undefined) return this.#failure
    if (this.#buffer.byteLength > 0) {
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
      if (
        typeof method !== 'string'
        || !isPlainObject(params)
        || !(keys.length === 1 || (keys.length === 2 && Object.hasOwn(message, 'params')))
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
    assertJsonValue(message, new Set<object>())
    const rendered = JSON.stringify(message)
    if (rendered === undefined) throw new TypeError('not JSON')
    const bytes = encoder.encode(`${rendered}\n`)
    if (bytes.byteLength > MAX_REQUEST) throw new CodexProtocolError('request_too_large')
    return bytes
  } catch (error) {
    if (error instanceof CodexProtocolError) throw error
    throw new CodexProtocolError('invalid_request')
  }
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('invalid number')
    }
    return
  }
  if (typeof value === 'string') {
    if (!isWellFormedString(value)) throw new TypeError('invalid string')
    return
  }
  if (typeof value !== 'object') throw new TypeError('invalid JSON value')
  if (ancestors.has(value)) throw new TypeError('cyclic JSON value')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, ancestors)
  } else {
    if (!isPlainObject(value)) throw new TypeError('non-plain JSON object')
    for (const item of Object.values(value)) assertJsonValue(item, ancestors)
  }
  ancestors.delete(value)
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

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd8_00 && unit <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc_00 || next > 0xdf_ff) return false
      index += 1
    } else if (unit >= 0xdc_00 && unit <= 0xdf_ff) return false
  }
  return true
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength)
  result.set(left)
  result.set(right, left.byteLength)
  return result
}

function abortError(): Error {
  const error = new Error('request aborted')
  error.name = 'AbortError'
  return error
}
