import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

import {
  WorkspaceGraphStore,
  WorkspaceGraphStoreError,
  type WorkspaceGraphBatchInput,
  type WorkspaceCard,
  type WorkspaceGraphStoreErrorCode,
} from './store.js'
import type { EvidenceRef, Observation, RelationCard } from './models.js'

interface StoreWorkerData {
  readonly path: string
  readonly deniedRoots: readonly string[]
  readonly publicationRevisionFloor?: number
  readonly testHooks?: {
    readonly exitAfterCommitBeforeResponse?: string
    readonly failAfterFirstRelationStatement?: boolean
    readonly holdAfterFirstRelationStatement?: SharedArrayBuffer
  }
}

interface StoreRequest {
  readonly kind: 'request'
  readonly request_id: number
  readonly operation: string
  readonly [key: string]: unknown
}

if (isMainThread || parentPort === null) {
  throw new Error('workspace graph store worker cannot run on the main thread')
}

const port = parentPort
const data = parseWorkerData(workerData)
let relationHookUsed = false
const store = new WorkspaceGraphStore(
  data.path,
  path => new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
  }),
  {
    deniedRoots: data.deniedRoots,
    ...(data.publicationRevisionFloor === undefined
      ? {}
      : {publicationRevisionFloor: data.publicationRevisionFloor}),
    ...(data.testHooks === undefined
      ? {}
      : {
        afterRelationStatement: () => {
          if (relationHookUsed) return
          relationHookUsed = true
          if (data.testHooks?.failAfterFirstRelationStatement === true) {
            throw new Error('injected relation statement failure')
          }
          const buffer = data.testHooks?.holdAfterFirstRelationStatement
          if (buffer !== undefined) {
            const barrier = new Int32Array(buffer)
            Atomics.store(barrier, 0, 1)
            Atomics.notify(barrier, 0)
            Atomics.wait(barrier, 0, 1)
          }
        },
      }),
  },
)

port.on('message', message => {
  const request = parseRequest(message)
  if (request === undefined) {
    port.postMessage({kind: 'protocol_error'})
    return
  }
  try {
    const {result, publish} = execute(request)
    if (data.testHooks?.exitAfterCommitBeforeResponse === request.operation) process.exit(86)
    let snapshot: unknown
    let publicationFailed = false
    if (publish) {
      try {
        snapshot = store.publishSnapshot()
      } catch {
        publicationFailed = true
      }
    }
    port.postMessage({
      kind: 'response',
      request_id: request.request_id,
      ok: true,
      result,
      ...(snapshot === undefined ? {} : {snapshot}),
      ...(publicationFailed ? {publication_failed: true} : {}),
    })
  } catch (error) {
    port.postMessage({
      kind: 'response',
      request_id: request.request_id,
      ok: false,
      error_code: safeErrorCode(error),
    })
  }
})

function execute(request: StoreRequest): {readonly result: unknown; readonly publish: boolean} {
  switch (request.operation) {
    case 'open':
      store.open()
      return {result: null, publish: true}
    case 'close':
      store.close()
      return {result: null, publish: false}
    case 'append_observation':
      return {
        result: store.appendObservation(
          request.observation as Observation,
          stringField(request, 'operationId'),
        ),
        publish: true,
      }
    case 'replace_card':
      store.replaceCard(request.card as WorkspaceCard, stringField(request, 'operationId'))
      return {result: null, publish: true}
    case 'upsert_relation':
      return {
        result: store.upsertRelation(
          request.card as RelationCard,
          typeof request.expectedRevision === 'number' ? request.expectedRevision : undefined,
          stringField(request, 'operationId'),
        ),
        publish: true,
      }
    case 'suppress_relation':
      return {
        result: store.suppressRelation(
          stringField(request, 'sourceId'),
          stringField(request, 'targetId'),
          request.relationType as RelationCard['relation_type'],
          request.evidence as EvidenceRef,
          stringField(request, 'operationId'),
        ),
        publish: true,
      }
    case 'compact':
      return {result: store.compact(stringField(request, 'operationId')), publish: true}
    case 'graph_batch':
      return {
        result: store.applyGraphBatch(
          request.batch as WorkspaceGraphBatchInput,
          stringField(request, 'operationId'),
        ),
        publish: true,
      }
    case 'load_graph_state':
      return {result: store.loadGraphState(), publish: false}
    case 'get_operation_receipt':
      return {result: store.getOperationReceipt(stringField(request, 'operationId')), publish: false}
    case 'publish_snapshot':
      return {result: null, publish: true}
    case 'list_observations':
      return {result: store.listObservations(), publish: false}
    case 'get_observation':
      return {
        result: store.getObservation(
          request.source as Observation['source'],
          stringField(request, 'ref'),
        ),
        publish: false,
      }
    case 'list_logical_workspaces':
      return {result: store.listLogicalWorkspaces(), publish: false}
    case 'get_logical_workspace':
      return {
        result: store.getLogicalWorkspace(stringField(request, 'logicalWorkspaceId')),
        publish: false,
      }
    case 'list_workspace_instances':
      return {
        result: store.listWorkspaceInstances(optionalStringField(request, 'logicalWorkspaceId')),
        publish: false,
      }
    case 'get_workspace_instance':
      return {
        result: store.getWorkspaceInstance(stringField(request, 'instanceId')),
        publish: false,
      }
    case 'list_relations':
      return {result: store.listRelations(), publish: false}
    case 'get_relation':
      return {
        result: store.getRelation(
          stringField(request, 'sourceId'),
          stringField(request, 'targetId'),
          request.relationType as RelationCard['relation_type'],
        ),
        publish: false,
      }
    case 'list_relation_evidence':
      return {
        result: store.listRelationEvidence(
          stringField(request, 'sourceId'),
          stringField(request, 'targetId'),
          request.relationType as RelationCard['relation_type'],
        ),
        publish: false,
      }
    case 'diagnostics':
      return {result: store.diagnostics(), publish: false}
    default:
      throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
  }
}

function parseWorkerData(value: unknown): StoreWorkerData {
  if (!isRecord(value) || typeof value.path !== 'string' || !Array.isArray(value.deniedRoots)) {
    throw new Error('invalid workspace graph worker configuration')
  }
  if (!value.deniedRoots.every(root => typeof root === 'string')) {
    throw new Error('invalid workspace graph worker configuration')
  }
  if (
    value.publicationRevisionFloor !== undefined
    && (
      typeof value.publicationRevisionFloor !== 'number'
      || !Number.isSafeInteger(value.publicationRevisionFloor)
      || value.publicationRevisionFloor < 0
    )
  ) {
    throw new Error('invalid workspace graph worker configuration')
  }
  let testHooks: StoreWorkerData['testHooks']
  if (value.testHooks !== undefined) {
    if (!isRecord(value.testHooks)) throw new Error('invalid workspace graph worker configuration')
    const hook = value.testHooks.exitAfterCommitBeforeResponse
    if (hook !== undefined && typeof hook !== 'string') {
      throw new Error('invalid workspace graph worker configuration')
    }
    const fail = value.testHooks.failAfterFirstRelationStatement
    if (fail !== undefined && typeof fail !== 'boolean') {
      throw new Error('invalid workspace graph worker configuration')
    }
    const hold = value.testHooks.holdAfterFirstRelationStatement
    if (
      hold !== undefined
      && (!(hold instanceof SharedArrayBuffer) || hold.byteLength < Int32Array.BYTES_PER_ELEMENT)
    ) {
      throw new Error('invalid workspace graph worker configuration')
    }
    testHooks = {
      ...(hook === undefined ? {} : {exitAfterCommitBeforeResponse: hook}),
      ...(fail === undefined ? {} : {failAfterFirstRelationStatement: fail}),
      ...(hold === undefined ? {} : {holdAfterFirstRelationStatement: hold}),
    }
  }
  return {
    path: value.path,
    deniedRoots: value.deniedRoots,
    ...(value.publicationRevisionFloor === undefined
      ? {}
      : {publicationRevisionFloor: value.publicationRevisionFloor}),
    ...(testHooks === undefined ? {} : {testHooks}),
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
  if (typeof value !== 'string') throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
  return value
}

function optionalStringField(request: StoreRequest, key: string): string | undefined {
  const value = request[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new WorkspaceGraphStoreError('STORE_READ_FAILED')
  return value
}

function safeErrorCode(error: unknown): WorkspaceGraphStoreErrorCode {
  return error instanceof WorkspaceGraphStoreError ? error.code : 'STORE_WRITE_FAILED'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
