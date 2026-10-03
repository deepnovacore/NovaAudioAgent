import type {MemoryOperation} from '../memory-substrate/store.js'
import { Worker, type WorkerOptions } from 'node:worker_threads'

import type {MemoryLedgerStoreErrorCode} from './store.js'

export interface MemoryLedgerWorker {
  postMessage(value: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface MemoryLedgerClientOptions {
  readonly memoryLockWaitMs?: number
  readonly workerFactory?: (url: URL, options: WorkerOptions) => MemoryLedgerWorker
}

export type MemoryLedgerClientErrorCode =
  | MemoryLedgerStoreErrorCode
  | 'CLIENT_CLOSED'
  | 'WORKER_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_PROTOCOL_FAILURE'

const clientErrorMessages: Readonly<Record<MemoryLedgerClientErrorCode, string>> = {
  CLIENT_CLOSED: 'memory ledger store client is closed',
  WORKER_ERROR: 'memory ledger worker failed',
  WORKER_EXITED: 'memory ledger worker exited',
  WORKER_PROTOCOL_FAILURE: 'memory ledger worker protocol failure',
  STORE_ALREADY_OPEN: 'memory ledger store is already open',
  STORE_CLOSED: 'memory ledger store is closed',
  STORE_IDEMPOTENCY_CONFLICT: 'memory ledger observation replay conflict',
  STORE_INVALID_CARD: 'invalid memory ledger card',
  STORE_INVALID_OBSERVATION: 'invalid memory ledger observation',
  STORE_INVALID_RELATION: 'invalid memory ledger relation',
  STORE_MIGRATION_FAILED: 'memory ledger schema migration failed',
  STORE_NOT_FOUND: 'memory ledger record was not found',
  STORE_INVALID_OPERATION: 'memory ledger operation is invalid',
  STORE_PURGED_ID: 'memory identifier was permanently purged',
  STORE_STATED_EVIDENCE_REQUIRED: 'stated memory requires trusted user evidence',
  STORE_OPERATION_CONFLICT: 'memory ledger operation replay conflict',
  STORE_READ_FAILED: 'memory ledger read failed',
  STORE_SCHEMA_UNSUPPORTED: 'memory ledger schema version is unsupported',
  STORE_SENSITIVE_CONTENT_REJECTED: 'memory ledger sensitive content was rejected',
  STORE_SENSITIVE_PATH_DENIED: 'memory ledger sensitive path was denied',
  STORE_STALE_REVISION: 'memory ledger revision is stale',
  STORE_MEMORY_CONFLICT: 'memory documents conflict; user edits were preserved',
  STORE_WRITE_FAILED: 'memory ledger write failed',
}

export class MemoryLedgerClientError extends Error {
  readonly code: MemoryLedgerClientErrorCode

  constructor(code: MemoryLedgerClientErrorCode) {
    super(clientErrorMessages[code])
    this.name = 'MemoryLedgerClientError'
    this.code = code
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: MemoryLedgerClientError) => void
  readonly validateResult: RpcResultValidator<unknown>
}

type RpcResultValidator<Result> = (value: unknown) => Result

interface WorkerSuccess {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: true
  readonly result: unknown
}

interface WorkerFailure {
  readonly kind: 'response'
  readonly request_id: number
  readonly ok: false
  readonly error_code: MemoryLedgerStoreErrorCode
}

type WorkerResponse = WorkerSuccess | WorkerFailure

const nullResult: RpcResultValidator<void> = value => {
  if (value !== null) throw new TypeError('invalid null RPC result')
}

export class MemoryLedgerClient {
  readonly #workerFactory: (url: URL, options: WorkerOptions) => MemoryLedgerWorker
  readonly #workerUrl = new URL('./store-worker.js', import.meta.url)
  readonly #workerData: {
    readonly path: string
    readonly memoryLockWaitMs?: number
  }
  #worker: MemoryLedgerWorker
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #failed = false
  #closed = false
  #expectedExit = false
  #closing: Promise<void> | null = null
  #opening: Promise<void> | null = null

  constructor(path: string, options: MemoryLedgerClientOptions = {}) {
    this.#workerData = {
      path,
      ...(options.memoryLockWaitMs === undefined ? {} : {memoryLockWaitMs: options.memoryLockWaitMs}),
    }
    this.#workerFactory = options.workerFactory
      ?? ((url: URL, configured: WorkerOptions) => new Worker(url, configured))
    this.#worker = this.#spawnWorker()
  }

  memory(operation: MemoryOperation, input: unknown): Promise<unknown> {
    return this.#request('memory', {memoryOperation: operation, input}, value => value)
  }

  async open(): Promise<void> {
    if (this.#closed || this.#failed) throw new MemoryLedgerClientError('CLIENT_CLOSED')
    this.#opening ??= this.#request('open', {}, nullResult)
    await this.#opening
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing
    if (this.#closed) return Promise.resolve()
    const operation = this.#closeFresh()
    this.#closing = operation
    return operation
  }

  async #closeFresh(): Promise<void> {
    this.#closed = true
    if (!this.#failed) {
      // Drain queued work and its lock cleanup before termination; worker errors/exits reject this RPC.
      await this.#requestWhileClosing('close', {}, nullResult).catch(() => undefined)
    }
    this.#expectedExit = true
    try {
      await this.#worker.terminate()
    } catch {
      // A worker that already exited is closed for client lifecycle purposes.
    }
    const error = new MemoryLedgerClientError('CLIENT_CLOSED')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #request<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    if (this.#closed || this.#failed) {
      return Promise.reject(new MemoryLedgerClientError('CLIENT_CLOSED'))
    }
    return this.#send(operation, payload, validateResult)
  }

  #requestWhileClosing<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    if (this.#failed) return Promise.reject(new MemoryLedgerClientError('CLIENT_CLOSED'))
    return this.#send(operation, payload, validateResult)
  }

  #send<Result>(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    validateResult: RpcResultValidator<Result>,
  ): Promise<Result> {
    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    const request = {kind: 'request', request_id: requestId, operation, ...payload} as const
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(requestId, {resolve: value => resolve(value as Result), reject, validateResult})
      try {
        this.#worker.postMessage(request)
      } catch {
        this.#pending.delete(requestId)
        reject(new MemoryLedgerClientError('WORKER_PROTOCOL_FAILURE'))
      }
    })
  }

  #handleMessage(worker: MemoryLedgerWorker, message: unknown): void {
    if (worker !== this.#worker) return
    const response = parseWorkerResponse(message)
    if (response === undefined) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    const pending = this.#pending.get(response.request_id)
    if (pending === undefined) {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    if (!response.ok) {
      this.#pending.delete(response.request_id)
      pending.reject(new MemoryLedgerClientError(response.error_code))
      return
    }
    let result: unknown
    try {
      result = pending.validateResult(response.result)
    } catch {
      this.#fail('WORKER_PROTOCOL_FAILURE')
      return
    }
    this.#pending.delete(response.request_id)
    pending.resolve(result)
  }

  #fail(code: Extract<MemoryLedgerClientErrorCode, `WORKER_${string}`>): void {
    if (this.#failed || this.#expectedExit) return
    this.#failed = true
    const error = new MemoryLedgerClientError(code)
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #spawnWorker(): MemoryLedgerWorker {
    const worker = this.#workerFactory(this.#workerUrl, {workerData: this.#workerData})
    worker.on('message', message => this.#handleMessage(worker, message))
    worker.on('error', () => this.#handleWorkerFailure(worker, 'WORKER_ERROR'))
    worker.on('exit', () => {
      if (!this.#expectedExit) this.#handleWorkerFailure(worker, 'WORKER_EXITED')
    })
    return worker
  }

  #handleWorkerFailure(
    worker: MemoryLedgerWorker,
    code: 'WORKER_ERROR' | 'WORKER_EXITED',
  ): void {
    if (worker !== this.#worker || this.#failed || this.#expectedExit) return
    this.#fail(code)
  }
}

function parseWorkerResponse(message: unknown): WorkerResponse | undefined {
  if (
    !isRecord(message)
    || message.kind !== 'response'
    || !Number.isSafeInteger(message.request_id)
    || (message.request_id as number) <= 0
  ) {
    return undefined
  }
  if (message.ok === true && 'result' in message) {
    if (!hasOnlyKeys(message, ['kind', 'request_id', 'ok', 'result'])) return undefined
    return {kind: 'response', request_id: message.request_id as number, ok: true, result: message.result}
  }
  if (message.ok === false && isStoreErrorCode(message.error_code)) {
    if (!hasOnlyKeys(message, ['kind', 'request_id', 'ok', 'error_code'])) return undefined
    return {
      kind: 'response',
      request_id: message.request_id as number,
      ok: false,
      error_code: message.error_code,
    }
  }
  return undefined
}

function isStoreErrorCode(value: unknown): value is MemoryLedgerStoreErrorCode {
  return typeof value === 'string' && value in clientErrorMessages && value.startsWith('STORE_')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}
