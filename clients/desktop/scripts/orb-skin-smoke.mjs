// Offline Chromium UI smoke. Uses isolated settings and never starts a voice backend.
import { app, BrowserWindow, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_SETTINGS,
  publicSettings,
  createSettingsWriter,
  loadSettings,
  saveSettings
} from '../src/main/settings-store.mjs'
import { validatePreparedSettings } from '../src/main/capabilities-settings.mjs'

const fixture = mkdtempSync(join(tmpdir(), 'nova-skin-smoke-'))
app.setPath('userData', join(fixture, 'profile'))
app.on('window-all-closed', () => {})
const deadline = setTimeout(() => {
  console.error('Skin smoke exceeded 30 seconds')
  app.exit(1)
}, 30_000)
async function main() {
  const root = resolve(import.meta.dirname, '../src/renderer')
  const output = resolve(import.meta.dirname, '../../../output')
  const settingsFile = join(fixture, 'settings.json')
  let current = DEFAULT_SETTINGS
  const write = createSettingsWriter({
    getCurrent: () => current,
    codec: { available: () => false },
    save: (next) => saveSettings(settingsFile, next),
    commit: (next) => {
      current = next
    }
  })
  const pack = await readFile(
    resolve(import.meta.dirname, '../../../skins/jarvis.nova-skin.json'),
    'utf8'
  )
  const markup = await readFile(join(root, 'settings.html'), 'utf8')
  const section = markup.match(
    /<section class="setting-section" id="orb-skin-section">[\s\S]*?<\/section>/
  )[0]
  const client = `
import {createSkinPanel} from './skin-panel.mjs'
import {createSettingsController} from './settings-controller.mjs'
const panel = createSkinPanel({document, stage: patch => controller.stage(patch), discard: () => controller.discardFields(['skinId', 'importedSkins'])})
const controller = createSettingsController({api: {set: patch => window.skinTest.save(patch)}, render: (view, drafts, state) => panel.render(view, state), status: text => {document.getElementById('save-status').textContent = text}})
controller.setView(await window.skinTest.load())
document.getElementById('save').onclick = () => controller.save()
window.testState = () => controller.snapshot()
window.testImport = text => { const transfer = new DataTransfer(); transfer.items.add(new File([text], 'skin.json', {type: 'application/json'})); const input = document.getElementById('orb-skin-file'); input.files = transfer.files; input.dispatchEvent(new Event('change')) }
window.skinReady = true
`
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html')
        res.end(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'"><link rel="stylesheet" href="/settings.css"><header><h1>Nova · 皮肤设置</h1></header><main>${section}</main><footer><span id="save-status" role="status"></span><button id="save">保存</button></footer><script type="module" src="/smoke.mjs"></script>`
        )
      } else if (path === '/smoke.mjs') {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(client)
      } else {
        if (!/^\/[a-z0-9.-]+\.(mjs|css)$/.test(path)) {
          res.writeHead(404)
          res.end()
          return
        }
        res.setHeader(
          'Content-Type',
          path.endsWith('.css') ? 'text/css' : 'text/javascript'
        )
        res.end(await readFile(join(root, path.slice(1))))
      }
    } catch {
      res.writeHead(500)
      res.end()
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  await writeFile(
    join(fixture, 'preload.cjs'),
    `const {contextBridge, ipcRenderer} = require('electron'); contextBridge.exposeInMainWorld('skinTest', {save: patch => ipcRenderer.invoke('test:save', patch), load: () => ipcRenderer.invoke('test:load')})`
  )
  let win,
    exitCode = 0
  const errors = []
  try {
    await app.whenReady()
    win = new BrowserWindow({
      show: false,
      width: 780,
      height: 700,
      webPreferences: {
        preload: join(fixture, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true
      }
    })
    win.webContents.on('console-message', (_event, details) => {
      if (details.level >= 3) errors.push(details.message)
    })
    ipcMain.handle('test:save', async (event, patch) => {
      assert.equal(event.sender, win.webContents)
      await write(patch, (next) => {
        validatePreparedSettings(patch, publicSettings(next))
      })
      return { ...publicSettings(current), saved: true, restarted: false }
    })
    ipcMain.handle('test:load', async () =>
      publicSettings(await loadSettings(settingsFile))
    )
    const run = (source) => win.webContents.executeJavaScript(source)
    async function until(expression) {
      for (let i = 0; i < 100; i++) {
        if (await run(expression)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI condition timed out: ${expression}`)
    }
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
    await until('window.skinReady === true')
    await run(`window.testImport('{')`)
    await until(
      `document.getElementById('orb-skin-status').textContent.includes('无效')`
    )
    assert.equal(current.skinId, 'nova')
    await run(`window.testImport(${JSON.stringify(pack)})`)
    await until(`window.testState().view.skinId === 'jarvis'`)
    assert.equal(current.skinId, 'nova', 'import stays a draft')
    await run(`document.getElementById('orb-skin-discard').click()`)
    assert.equal(await run(`window.testState().view.skinId`), 'nova')
    await run(`window.testImport(${JSON.stringify(pack)})`)
    await until(`window.testState().view.skinId === 'jarvis'`)
    await run(`document.getElementById('save').click()`)
    await until(`!window.testState().dirty && !window.testState().busy`)
    assert.equal(current.skinId, 'jarvis')
    await win.loadURL(win.webContents.getURL())
    await until(
      `window.skinReady === true && window.testState().view.skinId === 'jarvis'`
    )
    await mkdir(output, { recursive: true })
    await writeFile(
      join(output, 'orb-skin-settings.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await run(
      `document.getElementById('orb-skin-remove').click(); document.getElementById('save').click()`
    )
    await until(`!window.testState().dirty && !window.testState().busy`)
    assert.equal(current.skinId, 'nova')
    assert.deepEqual(current.importedSkins, [])
    assert.deepEqual(errors, [])
    console.log(
      'PASS: invalid import, preview, discard, save, reload, remove; no renderer errors'
    )
  } catch (error) {
    console.error(error, errors)
    exitCode = 1
  } finally {
    win?.destroy()
    server.close()
    await rm(fixture, { recursive: true, force: true })
    clearTimeout(deadline)
    app.exit(exitCode)
  }
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
