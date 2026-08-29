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
  assert.match(source, /memoryBoard\.export\(\{\s*channels: latestPayload\.channels,\s*diagnostics: latestPayload\.diagnostics,\s*\}\)/)

  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')
  assert.match(html, /<button id="export" type="button" disabled>导出<\/button>/)
})

test('board presents accessible Memory, Diagnostics and Graph tabs and never exports graph data', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const html = await readFile(new URL('../src/renderer/memory-board.html', import.meta.url), 'utf8')

  assert.match(html, /role="tablist"/)
  assert.match(html, /id="memory-tab"[^>]+role="tab"/)
  assert.match(html, /id="diagnostics-tab"[^>]+role="tab"/)
  assert.match(html, /id="graph-tab"[^>]+role="tab"/)
  assert.match(html, /id="memory-panel"[^>]+role="tabpanel"/)
  assert.match(html, /id="diagnostics-panel"[^>]+role="tabpanel"/)
  assert.match(html, /id="graph-panel"[^>]+role="tabpanel"/)
  assert.match(source, /graphBoard\.request\(\)/)
  assert.match(source, /exportButton\.hidden = activeTab === 'graph'/)
  assert.match(source, /boardTabForKey\(activeTab, event\.key\)/)
  assert.match(source, /tabElements\[nextTab\]/u)
  assert.match(source, /\.focus\(\)/)
  assert.doesNotMatch(source, /graphBoard\.export|workspace_graph\.board\.(?:delete|edit|suppress|merge|switch|inspect)/u)
})

test('diagnostics render versioned body-free lifecycle records', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/memory-board.css', import.meta.url), 'utf8')

  assert.match(source, /payload\?\.diagnostics\?\.version === 1/u)
  assert.match(source, /payload\.diagnostics\.records\.length <= 128/u)
  assert.match(source, /function renderDiagnostic\(/u)
  assert.match(source, /diagnosticsRoot\.replaceChildren/u)
  assert.match(css, /#diagnostics/u)
  assert.match(css, /\.diagnostic-record/u)
})

test('memory channels render as semantic cards with summary, count, tags, and a scroll region', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/renderer/memory-board.css', import.meta.url), 'utf8')

  assert.match(source, /section\.className = 'channel-card'/)
  assert.match(source, /header\.className = 'channel-header'/)
  assert.match(source, /count\.className = 'channel-count'/)
  assert.match(source, /summary\.className = 'channel-summary'/)
  assert.match(source, /itemsRoot\.className = 'channel-items'/)
  assert.match(source, /className = `tag tag-trust trust-\$\{item\.trust\}`/)
  assert.match(source, /className = 'tag tag-outcome'/)
  assert.match(source, /className = 'tag tag-truncated'/)
  assert.match(css, /#channels\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,/s)
  assert.match(css, /\.channel-items\s*\{[^}]*overflow:\s*auto;/s)
  assert.match(css, /font-family:\s*ui-monospace/)
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-columns:\s*1fr/)
})

test('export handler saves through a dialog with the atomic write pattern', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\('nova:memory-board:export', async \(event, payload\) => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/)
  assert.match(source, /payload\.diagnostics\.records\.length > 128/u)
  assert.match(source, /payload\.diagnostics\.records\.every/u)
  assert.match(source, /Buffer\.byteLength\(body, 'utf8'\) > 1024 \* 1024/)
  assert.match(source, /dialog\.showSaveDialog/)
  assert.match(source, /memory-board-/)
  assert.match(source, /exported_at/)
  assert.match(source, /mode: 0o600/)
  assert.match(source, /randomBytes\(4\)\.toString\('hex'\)/)
  assert.match(source, /const temporary = [^\n]+\n\s*try \{\n\s*await writeFile\(temporary/)
  assert.match(source, /await rename\(temporary, filePath\)/)
})

test('graph board main relay stays separate from the Memory and diagnostics export body', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /let pendingGraphBoardRequest = null/)
  assert.match(source, /pendingGraphBoardRequest\.resolve\(\{ error: 'superseded' \}\)/)
  assert.match(source, /sendToOrb\('nova:workspace-graph-board:fetch', requestId\)/)
  assert.match(source, /payload\.request_id !== pendingGraphBoardRequest\.requestId/)
  const exportBody = source.slice(source.indexOf("ipcMain.handle('nova:memory-board:export'"))
  assert.match(exportBody, /channels: payload\.channels/)
  assert.match(exportBody, /diagnostics: payload\.diagnostics/)
  assert.doesNotMatch(exportBody.slice(0, exportBody.indexOf("ipcMain.handle('nova:settings:get'")), /graph|workspace_graph/u)
})
