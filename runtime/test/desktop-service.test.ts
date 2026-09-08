import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  RealtimeDesktopService,
  startDesktopActivityHeartbeat,
  workspaceGraphBoardForRealtime,
} from '../src/desktop-service.js'
import type {PublishedGraphSnapshot} from '../src/workspace-graph/store.js'

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

test('activity heartbeat isolates failures, covers every idle axis, unrefs and stops on abort', t => {
  const originalInterval = globalThis.setInterval
  let tick: () => void = () => { throw new Error('timer not installed') }
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback
    return originalInterval(callback, 60_000)
  })
  const clear = t.mock.method(globalThis, 'clearInterval')
  const session = {foregroundIdle: true, floor: {state: 'idle'}, snapshot: () => ({active_delegates: [] as unknown[]})}
  const service = {session, executorState: 'idle'}
  const stop = new AbortController()
  const seen: boolean[] = []
  let publishThrows = false
  const timer = startDesktopActivityHeartbeat(service as never, idle => {
    if (publishThrows) throw new Error('transport failed')
    seen.push(idle)
  }, stop.signal)
  t.after(() => stop.abort())
  assert.equal(timer.hasRef(), false)
  tick(); assert.equal(seen.at(-1), true)
  session.foregroundIdle = false; tick(); assert.equal(seen.at(-1), false); session.foregroundIdle = true
  session.floor.state = 'speaking'; tick(); assert.equal(seen.at(-1), false); session.floor.state = 'idle'
  session.snapshot = () => ({active_delegates: [{}]}); tick(); assert.equal(seen.at(-1), false)
  session.snapshot = () => ({active_delegates: []})
  service.executorState = 'busy'; tick(); assert.equal(seen.at(-1), false); service.executorState = 'idle'
  Object.defineProperty(service, 'session', {configurable: true, get() { throw new Error('session unavailable') }})
  assert.doesNotThrow(tick); assert.equal(seen.at(-1), false)
  Object.defineProperty(service, 'session', {value: session})
  publishThrows = true; assert.doesNotThrow(tick)
  publishThrows = false; tick(); assert.equal(seen.at(-1), true)
  stop.abort(); assert.equal(clear.mock.callCount(), 1)
  const before = seen.length
  tick(); assert.equal(seen.length, before)
  const aborted = startDesktopActivityHeartbeat(service as never, () => { throw new Error('must not publish') }, stop.signal)
  assert.equal(aborted.hasRef(), false)
  assert.equal(clear.mock.callCount(), 2)
})
