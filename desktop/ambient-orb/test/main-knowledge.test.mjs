import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import {createKnowledgeActions} from '../src/main/knowledge-actions.mjs'

const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf("  ipcMain.handle('nova:knowledge:action'"), source.indexOf("  ipcMain.handle('nova:capabilities:probe'"))

test('actual Main knowledge handler fences native picker across backend/settings replacement', async () => {
  let receive, release, entered
  const picked = new Promise(resolve => {release = resolve})
  const started = new Promise(resolve => {entered = resolve})
  const sender = {}
  let calls = 0
  const context = vm.createContext({
    ipcMain: {handle: (_channel, fn) => {receive = fn}},
    settingsWindow: {webContents: sender}, settingsGeneration: 1,
    backendControl: {request: async () => {calls++; return {ok: true}}},
    runtimeCapabilities: {modules: {knowledge: {enabled: true}}}, createKnowledgeActions,
    dialog: {showOpenDialog: async () => {entered(); return picked}},
  })
  vm.runInContext(handler, context)
  await assert.rejects(receive({sender: {}}, {action: 'status'}), /rejected/)
  const pending = receive({sender}, {action: 'files', consent: true})
  await started
  context.settingsGeneration = 2
  release({canceled: false, filePaths: ['/documents/manual.md']})
  assert.equal((await pending).error, 'knowledge_unavailable_or_invalid_request')
  assert.equal(calls, 0)
})
