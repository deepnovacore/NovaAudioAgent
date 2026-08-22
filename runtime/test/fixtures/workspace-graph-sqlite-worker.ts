import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

interface FixtureWorkerData {
  readonly mode: 'exec' | 'query' | 'lock' | 'malformed' | 'invalid_success'
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
