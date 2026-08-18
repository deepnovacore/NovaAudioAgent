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

test('preload exposes the settings bridge as invoke/invoke/removable listener', async () => {
  const { exposed, ipcRenderer, invokes } = await loadPreload()

  assert.deepEqual(Object.keys(exposed.settings).sort(), ['get', 'onChanged', 'set'])
  assert.ok(Object.isFrozen(exposed.settings))

  await exposed.settings.get()
  await exposed.settings.set({ palette: 'graphite' })
  assert.deepEqual(invokes, [
    { channel: 'nova:settings:get', payload: undefined },
    { channel: 'nova:settings:set', payload: { palette: 'graphite' } },
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

test('preload declares each bridge namespace exactly once', async () => {
  const { source } = await loadPreload()

  for (const namespace of ['orbMenu', 'memoryBoard', 'nativeAudio', 'windowDrag', 'settings']) {
    const declarations = source.match(new RegExp(`^  ${namespace}: `, 'gm')) || []
    assert.equal(declarations.length, 1, `${namespace} is declared once`)
  }
})

