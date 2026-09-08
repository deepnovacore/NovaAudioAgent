import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  RealtimeDesktopService,
  workspaceGraphBoardForRealtime,
} from '../src/desktop-service.js'
import type {PublishedGraphSnapshot} from '../src/workspace-graph/store.js'

test('client-owned provider listens before waiting for phone and stops while unattached', async () => {
  const order: string[] = []
  const stop = new AbortController()
  const never = new Promise<void>(() => { /* Deliberately parked until owner cancellation. */ })
  const owner = new RealtimeDesktopService({
    listenBeforeRealtime: true,
    realtime: {service: {waitStopped: () => never}, start: () => {
      order.push('provider'); stop.abort(); return never
    }, stop: () => { order.push('stop'); return Promise.resolve() }},
    desktop: {server: {
      start: () => { order.push('listen'); return Promise.resolve({host: '127.0.0.1', port: 19876, token: 'a'.repeat(32)}) },
      close: () => { order.push('close'); return Promise.resolve() },
    }},
    readyEndpoint: '', stop,
    announce: () => { order.push('announce'); return Promise.resolve() },
    cleanupGraceMs: 20,
  })
  await owner.run()
  assert.deepEqual(order.slice(0, 3), ['listen', 'announce', 'provider'])
  assert.equal(order.filter(x => x === 'listen').length, 1)
  assert.ok(order.includes('stop')); assert.ok(order.includes('close'))
})

test('desktop owner rejects an invalid wrapper grace before touching resources', () => {
  const untouched = (): never => { throw new Error('resource was touched') }
  assert.throws(() => new RealtimeDesktopService({
    realtime: {
      service: {waitStopped: untouched},
      start: untouched,
      stop: untouched,
    },
    desktop: {server: {start: untouched, close: untouched}},
    readyEndpoint: '127.0.0.1:51515',
    stop: new AbortController(),
    announce: untouched,
    cleanupGraceMs: 0,
  }), /desktop cleanup grace must be positive and finite/u)
})

test('desktop graph composition reads only the published snapshot boundary', () => {
  const graph: PublishedGraphSnapshot = Object.freeze({
    schema_version: 3,
    publication_revision: 12,
    degraded: false,
    logical_workspaces: Object.freeze([]),
    workspace_instances: Object.freeze([]),
    relations: Object.freeze([]),
    aliases: Object.freeze([]),
  })
  const reads: string[] = []
  const workspaceGraph = new Proxy({publishedSnapshot: graph, degraded: false}, {
    get(target, property, receiver) {
      reads.push(String(property))
      if (property !== 'publishedSnapshot' && property !== 'degraded') {
        throw new Error(`forbidden graph method read: ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const payload = JSON.parse(workspaceGraphBoardForRealtime(
    'graph-composition',
    {workspaceGraph} as never,
  )) as {availability: string; publication_revision: number}
  assert.equal(payload.availability, 'ready')
  assert.equal(payload.publication_revision, 12)
  assert.deepEqual(reads.sort(), ['degraded', 'publishedSnapshot'])
})

test('desktop graph composition always answers disabled and degraded states safely', () => {
  const disabled = JSON.parse(workspaceGraphBoardForRealtime(
    'graph-disabled',
    {workspaceGraph: undefined},
  )) as {availability: string; logical_workspaces: unknown[]}
  assert.equal(disabled.availability, 'disabled')
  assert.deepEqual(disabled.logical_workspaces, [])

  const degraded = JSON.parse(workspaceGraphBoardForRealtime('graph-degraded', {
    workspaceGraph: {
      degraded: true,
      publishedSnapshot: Object.freeze({
        schema_version: 3,
        publication_revision: 4,
        degraded: false,
        logical_workspaces: Object.freeze([]),
        workspace_instances: Object.freeze([]),
        relations: Object.freeze([]),
        aliases: Object.freeze([]),
      }),
    },
  } as never)) as {availability: string; publication_revision: number}
  assert.equal(degraded.availability, 'degraded')
  assert.equal(degraded.publication_revision, 4)
})
