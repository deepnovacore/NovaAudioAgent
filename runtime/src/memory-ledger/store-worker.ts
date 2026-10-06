import {dirname} from 'node:path'
import {hostProjectRootFromConfig} from '../projects/project-store.js'
import {closeSync,constants,fchmodSync,fstatSync,lstatSync,openSync,realpathSync} from 'node:fs'
import {preparePrivateDatabasePath,secureSidecar} from '../storage/private-database.js'
import type {MemoryOperation} from '../memory-substrate/store.js'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

import {MemoryLedgerStore, MemoryLedgerStoreError, type MemoryLedgerStoreErrorCode} from './store.js'

interface StoreWorkerData {
  readonly path: string
  readonly memoryLockWaitMs?: number
}

interface StoreRequest {
  readonly kind: 'request'
  readonly request_id: number
  readonly operation: string
  readonly [key: string]: unknown
}

if (isMainThread || parentPort === null) {
  throw new Error('memory ledger worker cannot run on the main thread')
}

const port = parentPort
const data = parseWorkerData(workerData)
const store = new MemoryLedgerStore(
  data.path,
  path => {
    const prepared=privateLedgerPath(path)
    secureSidecar(prepared,'-wal');secureSidecar(prepared,'-shm')
    return new DatabaseSync(prepared,{allowExtension:false,enableForeignKeyConstraints:true})
  },
  data.memoryLockWaitMs === undefined ? {} : {memoryLockWaitMs: data.memoryLockWaitMs},
)

port.on('message', message => {
  const request = parseRequest(message)
  if (request === undefined) {
    port.postMessage({kind: 'protocol_error'})
    return
  }
  try {
    const result=store.withMemoryFilesLock(()=>{
      if(request.operation!=='memory'&&request.operation!=='close')store.syncMemoryFiles()
      const response=execute(request)
      if(request.operation!=='memory'&&request.operation!=='close')store.flushMemoryFiles()
      return response
    })
    port.postMessage({kind: 'response', request_id: request.request_id, ok: true, result})
  } catch (error) {
    port.postMessage({
      kind: 'response',
      request_id: request.request_id,
      ok: false,
      error_code: safeErrorCode(error),
    })
  }
})

function execute(request: StoreRequest): unknown {
  switch (request.operation) {
    case 'memory': {
      const operation=stringField(request,'memoryOperation') as MemoryOperation
      return store.memory(operation,request.input,path=>new DatabaseSync(path,{readOnly:true,allowExtension:false}))
    }
    case 'open': {
      store.open()
      const path=privateLedgerPath(data.path);secureSidecar(path,'-wal');secureSidecar(path,'-shm')
      return null
    }
    case 'close':
      store.close()
      return null
    default:
      throw new MemoryLedgerStoreError('STORE_READ_FAILED')
  }
}

function parseWorkerData(value: unknown): StoreWorkerData {
  if (!isRecord(value) || typeof value.path !== 'string') {
    throw new Error('invalid memory ledger worker configuration')
  }
  if (
    value.memoryLockWaitMs !== undefined
    && (typeof value.memoryLockWaitMs !== 'number' || !Number.isSafeInteger(value.memoryLockWaitMs) || value.memoryLockWaitMs < 0)
  ) {
    throw new Error('invalid memory ledger worker configuration')
  }
  return {
    path: value.path,
    ...(value.memoryLockWaitMs === undefined ? {} : {memoryLockWaitMs: value.memoryLockWaitMs}),
  }
}

function parseRequest(value: unknown): StoreRequest | undefined {
  if (
    !isRecord(value)
    || value.kind !== 'request'
    || !Number.isSafeInteger(value.request_id)
    || (value.request_id as number) <= 0
    || typeof value.operation !== 'string'
  ) return undefined
  return value as StoreRequest
}

function stringField(request: StoreRequest, key: string): string {
  const value = request[key]
  if (typeof value !== 'string') throw new MemoryLedgerStoreError('STORE_READ_FAILED')
  return value
}

function safeErrorCode(error: unknown): MemoryLedgerStoreErrorCode {
  return error instanceof MemoryLedgerStoreError ? error.code : error instanceof Error&&error.message.startsWith('MEMORY_MARKDOWN_')?'STORE_MEMORY_CONFLICT':'STORE_WRITE_FAILED'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Upgrade owner-held ledger files before they can receive raw personal evidence. */
function privateLedgerPath(input:string):string {
  // macOS exposes system temp directories through fixed OS-owned aliases.
  let path=input
  if(process.platform==='darwin')for(const root of ['/var','/tmp'])if(path.startsWith(root+'/'))path=realpathSync(root)+path.slice(root.length)
  let descriptor:number|undefined
  try {
    const before=lstatSync(path)
    hostProjectRootFromConfig(dirname(path))
    if(before.isSymbolicLink()||!before.isFile()||(process.getuid!==undefined&&before.uid!==process.getuid()))throw Error('invalid private ledger file')
    descriptor=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW)
    const opened=fstatSync(descriptor)
    if(opened.dev!==before.dev||opened.ino!==before.ino||!opened.isFile())throw Error('ledger file changed')
    if(process.platform!=='win32')fchmodSync(descriptor,0o600)
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
  } finally {if(descriptor!==undefined)closeSync(descriptor)}
  return preparePrivateDatabasePath(path)
}
