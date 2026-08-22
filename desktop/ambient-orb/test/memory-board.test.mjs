import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('board auto-refresh is renderer-owned, guarded, and visibility-aware', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /setInterval\(/)
  assert.match(source, /2000/)
  assert.match(source, /let inFlight = false/)
  assert.match(source, /if \(inFlight\) return/)
  assert.match(source, /document\.hidden/)
  assert.match(source, /let exportInFlight = false/)
  assert.match(source, /exportButton\.disabled = exportInFlight/)
})

test('board caches the latest payload and exports it through the preload API', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /let latestPayload = null/)
  assert.match(source, /latestPayload = payload/)
  assert.match(source, /memoryBoard\.export\(\{\s*channels: latestPayload\.channels,\s*\}\)/)

  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')
  assert.match(html, /<button id="export" type="button" disabled>导出<\/button>/)
})

test('board presents accessible Memory and Graph tabs and never exports graph data', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')

  assert.match(html, /role="tablist"/)
  assert.match(html, /id="memory-tab"[^>]+role="tab"/)
  assert.match(html, /id="graph-tab"[^>]+role="tab"/)
  assert.match(html, /id="memory-panel"[^>]+role="tabpanel"/)
  assert.match(html, /id="graph-panel"[^>]+role="tabpanel"/)
  assert.match(source, /graphBoard\.request\(\)/)
  assert.match(source, /exportButton\.hidden = activeTab === 'graph'/)
  assert.match(source, /boardTabForKey\(activeTab, event\.key\)/)
  assert.match(source, /nextTab === 'graph' \? graphTab : memoryTab/u)
  assert.match(source, /\.focus\(\)/)
  assert.doesNotMatch(source, /graphBoard\.export|workspace_graph\.board\.(?:delete|edit|suppress|merge|switch|inspect)/u)
})

test('export handler saves through a dialog with the atomic write pattern', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:memory-board:export', async \(event, payload\) => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/)
  assert.match(source, /Buffer\.byteLength\(body, 'utf8'\) > 1024 \* 1024/)
  assert.match(source, /dialog\.showSaveDialog/)
  assert.match(source, /memory-board-/)
  assert.match(source, /exported_at/)
  assert.match(source, /mode: 0o600/)
  assert.match(source, /randomBytes\(4\)\.toString\('hex'\)/)
  assert.match(source, /const temporary = [^\n]+\n\s*try \{\n\s*await writeFile\(temporary/)
  assert.match(source, /await rename\(temporary, filePath\)/)
})

test('graph board main relay stays separate from the unchanged Memory export body', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /let pendingGraphBoardRequest = null/)
  assert.match(source, /pendingGraphBoardRequest\.resolve\(\{ error: 'superseded' \}\)/)
  assert.match(source, /sendToOrb\('nova:workspace-graph-board:fetch', requestId\)/)
  assert.match(source, /payload\.request_id !== pendingGraphBoardRequest\.requestId/)
  const exportBody = source.slice(source.indexOf("ipcMain.handle('nova:memory-board:export'"))
  assert.match(exportBody, /channels: payload\.channels/)
  assert.doesNotMatch(exportBody.slice(0, exportBody.indexOf("ipcMain.handle('nova:settings:get'")), /graph|workspace_graph/u)
})
