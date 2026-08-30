import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createBoardAutoScroller } from '../src/renderer/board-auto-scroll.mjs'

test('board auto-scroll follows the document and every marked scroll region after refresh', () => {
  const page = {scrollHeight: 840, scrollTop: 12}
  const memory = {scrollHeight: 420, scrollTop: 0}
  const diagnostics = {scrollHeight: 250, scrollTop: 30}
  const frames = []
  const document = {
    scrollingElement: page,
    querySelectorAll: selector => {
      assert.equal(selector, '[data-auto-scroll-bottom]')
      return [memory, diagnostics]
    },
  }
  const scrollAfterRefresh = createBoardAutoScroller({
    document,
    requestFrame: callback => { frames.push(callback) },
  })

  scrollAfterRefresh()
  scrollAfterRefresh()

  assert.equal(frames.length, 1, 'same-turn refreshes share one post-layout frame')
  assert.deepEqual([page.scrollTop, memory.scrollTop, diagnostics.scrollTop], [12, 0, 30])
  frames.shift()()
  assert.deepEqual([page.scrollTop, memory.scrollTop, diagnostics.scrollTop], [840, 420, 250])
})

test('board auto-refresh is renderer-owned, guarded, and visibility-aware', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /setInterval\(/)
  assert.match(source, /2000/)
  assert.match(source, /let inFlight = false/)
  assert.match(source, /if \(inFlight\) return/)
  assert.match(source, /async function load\(\) \{\n\s*if \(document\.hidden\) return/)
  assert.match(source, /const owner = loadOwnership[\s\S]*await window\.novaAudioAgentDesktop\.memoryBoard\.request\(\)[\s\S]*owner !== loadOwnership/u)
  assert.match(source, /document\.hidden\) \{\s*loadOwnership \+= 1/u)
  assert.match(source, /addEventListener\('visibilitychange'/)
  assert.match(source, /let exportInFlight = false/)
  assert.match(source, /exportButton\.disabled = exportInFlight/)
})

test('board caches the latest payload and exports it through the preload API', async () => {
  const source = await readFile(new URL('../src/renderer/memory-board.mjs', import.meta.url), 'utf8')

  assert.match(source, /let latestPayload = null/)
  assert.match(source, /latestPayload = payload/)
  assert.match(source, /memoryBoard\.export\(\)/)
  assert.doesNotMatch(source, /memoryBoard\.export\(\{\s*channels:/)

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

  assert.match(source, /ipcMain\.handle\('nova:memory-board:export', async event => \{\n\s*if \(!boardWindow \|\| event\.sender !== boardWindow\.webContents\)/)
  assert.match(source, /requestBoardSnapshot\(backendStatus\.connection, \{\s*board: 'memory',\s*detail: 'full',\s*\}\)/u)
  assert.match(source, /snapshot\.diagnostics\.records\.length > 128/u)
  assert.match(source, /snapshot\.diagnostics\.records\.every/u)
  assert.match(source, /Buffer\.byteLength\(body, 'utf8'\) > 1024 \* 1024/)
  assert.match(source, /dialog\.showSaveDialog/)
  assert.match(source, /memory-board-/)
  assert.match(source, /exported_at/)
  assert.match(source, /mode: 0o600/)
  assert.match(source, /randomBytes\(4\)\.toString\('hex'\)/)
  assert.match(source, /const temporary = [^\n]+\n\s*try \{\n\s*await writeFile\(temporary/)
  assert.match(source, /await rename\(temporary, filePath\)/)
})

test('main requests compact board snapshots directly without relaying through the orb', async () => {
  const source = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')
  assert.match(source, /createDebugBoardRequester\(\)/)
  assert.match(source, /board: 'memory',\s*detail: 'compact'/u)
  assert.match(source, /board: 'workspace_graph',\s*detail: 'compact'/u)
  assert.doesNotMatch(source, /nova:memory-board:(?:fetch|data)/u)
  assert.doesNotMatch(source, /nova:workspace-graph-board:(?:fetch|data)/u)
  const exportBody = source.slice(source.indexOf("ipcMain.handle('nova:memory-board:export'"))
  assert.match(exportBody, /channels: snapshot\.channels/)
  assert.match(exportBody, /diagnostics: snapshot\.diagnostics/)
  assert.doesNotMatch(exportBody.slice(0, exportBody.indexOf("ipcMain.handle('nova:settings:get'")), /graph|workspace_graph/u)
})
