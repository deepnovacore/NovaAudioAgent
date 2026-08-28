import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadPreload() {
  const source = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const ipcRenderer = new EventEmitter()
  const invokes = []
  const sends = []
  ipcRenderer.invoke = async (channel, payload) => {
    invokes.push({ channel, payload })
    return {}
  }
  ipcRenderer.send = (channel, payload) => { sends.push({ channel, payload }) }
  let exposed
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld(_name, value) { exposed = value } }, ipcRenderer }
    },
    Object,
  })
  return { exposed, ipcRenderer, invokes, sends, source }
}

test('preload exposes a removable backend-exit listener without exposing ipcRenderer', async () => {
  const { exposed, ipcRenderer } = await loadPreload()

  let exits = 0
  const unsubscribe = exposed.onBackendExit(() => { exits += 1 })
  ipcRenderer.emit('nova:backend-exit', {})
  unsubscribe()
  ipcRenderer.emit('nova:backend-exit', {})

  assert.equal(exits, 1)
  assert.equal(exposed.ipcRenderer, undefined)
})

test('preload exposes a removable backend-ready listener', async () => {
  const { exposed, ipcRenderer } = await loadPreload()
  const received = []
  const unsubscribe = exposed.onBackendReady(value => received.push(value))
  ipcRenderer.emit('nova:backend-ready', {}, {endpoint: 'ws://127.0.0.1:7/'})
  unsubscribe()
  ipcRenderer.emit('nova:backend-ready', {}, {endpoint: 'ignored'})
  assert.deepEqual(received, [{endpoint: 'ws://127.0.0.1:7/'}])
})

test('preload exposes sanitized backend status and explicit settings retry', async () => {
  const {exposed, ipcRenderer, invokes} = await loadPreload()
  const seen = []
  const unsubscribe = exposed.onBackendStatus(status => seen.push(status))
  ipcRenderer.emit('nova:backend-status', {}, {state: 'configuration_required'})
  unsubscribe()
  assert.deepEqual(seen, [{state: 'configuration_required'}])
  await exposed.settings.retryBackend()
  assert.deepEqual(invokes, [{channel: 'nova:backend:retry', payload: undefined}])
})

test('preload exposes the settings bridge as invoke/invoke/removable listener', async () => {
  const { exposed, ipcRenderer, invokes } = await loadPreload()

  assert.deepEqual(Object.keys(exposed.settings).sort(), [
    'get', 'onChanged', 'repairProjects', 'rescanCodex', 'retryBackend', 'retryMicrophone', 'set',
  ])
  assert.ok(Object.isFrozen(exposed.settings))

  await exposed.settings.get()
  await exposed.settings.set({ palette: 'graphite' })
  await exposed.settings.rescanCodex()
  await exposed.settings.repairProjects('state')
  await exposed.settings.retryMicrophone()
  assert.deepEqual(invokes, [
    { channel: 'nova:settings:get', payload: undefined },
    { channel: 'nova:settings:set', payload: { palette: 'graphite' } },
    { channel: 'nova:codex:rescan', payload: undefined },
    { channel: 'nova:projects:repair', payload: 'state' },
    { channel: 'nova:microphone:retry', payload: undefined },
  ])

  const seen = []
  const unsubscribe = exposed.settings.onChanged(next => seen.push(next))
  ipcRenderer.emit('nova:settings:changed', {}, { palette: 'graphite' })
  unsubscribe()
  ipcRenderer.emit('nova:settings:changed', {}, { palette: 'ember' })

  assert.deepEqual(seen, [{ palette: 'graphite' }])
  // A non-function argument must not throw into the renderer.
  assert.equal(typeof exposed.settings.onChanged(null), 'function')
})

test('preload exposes a bounded microphone permission lifecycle', async () => {
  const { exposed, ipcRenderer, invokes, sends } = await loadPreload()

  assert.deepEqual(Object.keys(exposed.microphone).sort(), ['onRetry', 'report', 'requestPermission'])
  await exposed.microphone.requestPermission()
  exposed.microphone.report('device_busy')
  const retries = []
  const unsubscribe = exposed.microphone.onRetry(() => retries.push('retry'))
  ipcRenderer.emit('nova:microphone:retry', {})
  unsubscribe()
  ipcRenderer.emit('nova:microphone:retry', {})

  assert.deepEqual(invokes, [{ channel: 'nova:microphone:permission', payload: undefined }])
  assert.deepEqual(sends, [{ channel: 'nova:microphone:status', payload: 'device_busy' }])
  assert.deepEqual(retries, ['retry'])
})

test('preload exposes one bounded native playback mute command', async () => {
  const { exposed, invokes } = await loadPreload()

  assert.equal(typeof exposed.nativeAudio.setPlaybackMuted, 'function')
  await exposed.nativeAudio.setPlaybackMuted(true)
  await exposed.nativeAudio.setPlaybackMuted(false)

  assert.deepEqual(invokes, [
    { channel: 'nova:native-audio:playback-muted', payload: true },
    { channel: 'nova:native-audio:playback-muted', payload: false },
  ])
})

test('preload exposes a distinct read-only workspace graph board relay', async () => {
  const { exposed, ipcRenderer, invokes, sends } = await loadPreload()

  assert.deepEqual(Object.keys(exposed.graphBoard).sort(), ['onFetch', 'publish', 'request'])
  assert.ok(Object.isFrozen(exposed.graphBoard))
  await exposed.graphBoard.request()
  assert.deepEqual(invokes, [{channel: 'nova:workspace-graph-board:request', payload: undefined}])

  const requests = []
  const unsubscribe = exposed.graphBoard.onFetch(requestId => requests.push(requestId))
  ipcRenderer.emit('nova:workspace-graph-board:fetch', {}, 'graph-1')
  unsubscribe()
  ipcRenderer.emit('nova:workspace-graph-board:fetch', {}, 'graph-2')
  assert.deepEqual(requests, ['graph-1'])

  exposed.graphBoard.publish({type: 'workspace_graph.board', request_id: 'graph-1'})
  assert.deepEqual(sends, [{
    channel: 'nova:workspace-graph-board:data',
    payload: {type: 'workspace_graph.board', request_id: 'graph-1'},
  }])
  assert.equal(exposed.graphBoard.export, undefined)
})

test('preload declares each bridge namespace exactly once', async () => {
  const { source } = await loadPreload()

  for (const namespace of ['orbMenu', 'releaseCamera', 'microphone', 'memoryBoard', 'graphBoard', 'nativeAudio', 'windowDrag', 'settings']) {
    const declarations = source.match(new RegExp(`^  ${namespace}: `, 'gm')) || []
    assert.equal(declarations.length, 1, `${namespace} is declared once`)
  }
})
