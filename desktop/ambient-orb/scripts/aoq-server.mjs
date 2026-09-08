/** Local convenience launcher: reuse Nova's existing OS-encrypted key without exporting it. */
import {app, safeStorage} from 'electron'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createSafeStorageCodec, readSecret} from '../src/main/settings-store.mjs'
import {runServerEntry} from '../../../runtime/dist/src/server-entry.js'

app.setName('@nova-audio-agent/ambient-orb')
app.setPath('userData', join(app.getPath('appData'), '@nova-audio-agent', 'ambient-orb'))
app.on('window-all-closed', () => { /* Headless service has no windows. */ })
// Do not top-level await ready: Electron must finish evaluating this ESM entry first.
app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const settings = JSON.parse(readFileSync(join(app.getPath('userData'), 'ambient-orb-settings.json'), 'utf8'))
    const key = readSecret(settings, 'dashscopeApiKey', createSafeStorageCodec(safeStorage))
    if (!key) { console.error('[runtime-diagnostic] stored_dashscope_key_unavailable'); app.exit(2); return }
    const code = await runServerEntry({environment: {
      ...process.env, DASHSCOPE_API_KEY: key, NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: process.env.NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE ?? 'aoq_runtime',
    }})
    app.exit(code)
  } catch {
    console.error('[runtime-diagnostic] aoq_launcher_failed')
    app.exit(2)
  }
})
