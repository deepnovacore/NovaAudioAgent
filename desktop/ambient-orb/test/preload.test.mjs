import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('preload exposes a removable backend-exit listener without exposing ipcRenderer', async () => {
  const source = await readFile(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async () => ({})
  ipcRenderer.send = () => {}
  let exposed
  const contextBridge = {
    exposeInMainWorld(_name, value) { exposed = value },
  }
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge, ipcRenderer }
    },
    Object,
  })

  let exits = 0
  const unsubscribe = exposed.onBackendExit(() => { exits += 1 })
  ipcRenderer.emit('nova:backend-exit', {})
  unsubscribe()
  ipcRenderer.emit('nova:backend-exit', {})

  assert.equal(exits, 1)
  assert.equal(exposed.ipcRenderer, undefined)
})
