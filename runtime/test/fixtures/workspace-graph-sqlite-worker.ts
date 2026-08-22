import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

interface FixtureWorkerData {
  readonly mode:
    | 'exec'
    | 'query'
    | 'lock'
    | 'malformed'
    | 'invalid_success'
    | 'invalid_result'
    | 'invalid_snapshot_schema'
    | 'invalid_snapshot_status'
    | 'stale_snapshot'
    | 'extra_response_field'
  readonly path?: string
  readonly sql?: string
}

if (isMainThread || parentPort === null) {
  throw new Error('workspace graph SQLite fixture must run in a test worker')
}

const port = parentPort
const data = workerData as FixtureWorkerData

if (data.mode === 'malformed') {
  port.postMessage({kind: 'not-a-store-response'})
} else if (data.mode === 'invalid_success') {
  port.once('message', message => {
    const requestId = (message as {readonly request_id?: unknown}).request_id
    port.postMessage({kind: 'response', request_id: requestId, ok: true, result: null})
  })
} else if (
  data.mode === 'invalid_result'
  || data.mode === 'invalid_snapshot_schema'
  || data.mode === 'invalid_snapshot_status'
  || data.mode === 'stale_snapshot'
  || data.mode === 'extra_response_field'
) {
  let requests = 0
  port.on('message', message => {
    requests += 1
    const requestId = (message as {readonly request_id?: unknown}).request_id
    const relation = {
      source_logical_id: 'lw-a',
      target_logical_id: 'lw-b',
      relation_type: 'depends_on',
      confidence: 0.8,
      reason: 'shared runtime',
      evidence_refs: [{source: 'runtime', ref: 'fixture-evidence', observed_at: 1}],
      first_seen_at: 1,
      last_seen_at: 1,
      status: 'stale',
      revision: 0,
    }
    const snapshot = {
      schema_version: data.mode === 'invalid_snapshot_schema' ? 1 : 2,
      publication_revision: data.mode === 'stale_snapshot' ? 1 : requests,
      degraded: false,
      logical_workspaces: [],
      workspace_instances: [],
      relations: data.mode === 'invalid_snapshot_status' ? [relation] : [],
      aliases: [],
    }
    port.postMessage({
      kind: 'response',
      request_id: requestId,
      ok: true,
      result: data.mode === 'invalid_result' ? 'not-null' : null,
      snapshot,
      ...(data.mode === 'extra_response_field' ? {unexpected_payload: 'must-not-pass'} : {}),
    })
  })
} else {
  if (typeof data.path !== 'string') throw new Error('missing fixture database path')
  const database = new DatabaseSync(data.path)

  if (data.mode === 'exec') {
    if (typeof data.sql !== 'string') throw new Error('missing fixture SQL')
    database.exec(data.sql)
    database.close()
    port.postMessage({kind: 'done'})
  } else if (data.mode === 'query') {
    if (typeof data.sql !== 'string') throw new Error('missing fixture SQL')
    const rows = database.prepare(data.sql).all()
    database.close()
    port.postMessage({kind: 'rows', rows})
  } else {
    database.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE')
    port.postMessage({kind: 'locked'})
    port.once('message', message => {
      if (message !== 'release') throw new Error('invalid fixture release')
      database.exec('ROLLBACK')
      database.close()
      port.postMessage({kind: 'released'})
    })
  }
}
