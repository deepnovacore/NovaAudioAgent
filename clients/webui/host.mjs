import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {access, chmod, mkdir, readFile, unlink, writeFile} from 'node:fs/promises'
import {createServer} from 'node:net'
import {homedir} from 'node:os'
import {resolve, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline'
import {applySettingsUpdate, normalizeSettings, publicSettings, secretsPresent, readSecret, saveSettings, SECRET_KEYS} from '../desktop/src/main/settings-store.mjs'
import {validatePreparedSettings, invalidCommit} from '../desktop/src/main/capabilities-settings.mjs'
import {capabilityEnvironment, shutdownBackend} from '../desktop/src/main/backend.mjs'

const fields = ['pipelineMode', 'integratedModel', 'integratedVoice', 'cascadedLlmProvider', 'cascadedLlmModels', 'cascadedTtsVoice', 'modelBaseUrl', 'plannerModel']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unavailable = message => Object.assign(new Error(message), {code: 'runtime_unavailable'})
const entry = fileURLToPath(new URL('../../runtime/dist/src/server-entry.js', import.meta.url))

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

// Launcher injection keeps lifecycle tests independent of providers and real credentials.
export async function createLocalHost({stateDir = join(homedir(), '.config/nova/webui'), environment = process.env, launcher = spawn} = {}) {
  stateDir = resolve(stateDir)
  await mkdir(stateDir, {recursive: true, mode: 0o700})
  await chmod(stateDir, 0o700)
  const settingsFile = join(stateDir, 'settings.json')
  let settings = normalizeSettings()
  try { settings = normalizeSettings(JSON.parse(await readFile(settingsFile, 'utf8'))); await chmod(settingsFile, 0o600) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Web settings could not be read; repair settings.json before starting.') }
  try { await writeFile(join(stateDir, 'capabilities.json'), JSON.stringify({version: 1}), {mode: 0o600, flag: 'wx'}) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const token = randomBytes(16).toString('hex')
  const tokenFile = join(stateDir, `runtime-${process.pid}-${randomBytes(4).toString('hex')}.token`)
  await writeFile(tokenFile, `${token}\n`, {mode: 0o600, flag: 'wx'})
  await mkdir(join(stateDir, 'workspace'), {recursive: true, mode: 0o700})
  let child = null, endpoint = null, runtimeStatus = 'stopped', closed = false
  let queue = Promise.resolve()
  const serial = action => {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  const view = () => {
    const values = publicSettings(settings)
    return {...Object.fromEntries(fields.map(key => [key, values[key]])), secretsPresent: secretsPresent(settings), runtimeStatus, storageProtection: 'file-permissions'}
  }
  async function stop() {
    if (!child) return
    runtimeStatus = 'stopping'
    try { await shutdownBackend(child) }
    catch { runtimeStatus = 'failed'; throw unavailable('Runtime termination could not be confirmed.') }
    child = null; endpoint = null; runtimeStatus = 'stopped'
  }
  async function start() {
    if (closed) throw unavailable('Web host is closed.')
    if (child && runtimeStatus === 'ready') return endpoint
    if (child) await stop()
    try { await access(entry) } catch { throw unavailable('Runtime is not built. Run npm run build --workspace @nova-audio-agent/runtime.') }
    runtimeStatus = 'starting'
    try {
      const port = await freePort()
      const expectedEndpoint = `ws://127.0.0.1:${port}/client/v1`
      // Web settings own Nova configuration; a cleared key cannot reappear from the parent.
      const base = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('NOVA_AUDIO_AGENT_') && !['DASHSCOPE_API_KEY', 'TAVILY_API_KEY', 'ARK_API_KEY', 'DOUBAO_BIGMODEL_API_KEY', 'DOUBAO_ASR_API_KEY'].includes(key)))
      const secrets = Object.fromEntries(SECRET_KEYS.map(key => [key, readSecret(settings, key)]))
      const env = capabilityEnvironment(settings, secrets, base)
      Object.assign(env, {
        NOVA_AUDIO_AGENT_SERVER_TOKEN_FILE: tokenFile,
        NOVA_AUDIO_AGENT_SERVER_PORT: String(port),
        NOVA_AUDIO_AGENT_SERVER_MEDIA_MODE: 'relay',
        NOVA_AUDIO_AGENT_CODEX_WORKSPACE: join(stateDir, 'workspace'),
        NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT: join(stateDir, 'workspace'),
        NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT: join(stateDir, '.data'),
        NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG: join(stateDir, 'capabilities.json'),
        NOVA_AUDIO_AGENT_BLACKBOARD_PATH: join(stateDir, 'blackboard.sqlite'),
        NOVA_AUDIO_AGENT_KNOWLEDGE_PATH: join(stateDir, 'knowledge.sqlite'),
        NOVA_AUDIO_AGENT_PIPELINE_MODE: settings.pipelineMode,
        NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER: 'qwen',
        NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL: settings.integratedModel,
        NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE: settings.integratedVoice,
        NOVA_AUDIO_AGENT_CASCADE_ENDPOINTING_PROVIDER: 'auto',
        NOVA_AUDIO_AGENT_CASCADE_ASR_PROVIDER: 'volcengine',
        NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER: settings.cascadedLlmProvider,
        NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL: settings.cascadedLlmModels[settings.cascadedLlmProvider],
        NOVA_AUDIO_AGENT_CASCADE_TTS_PROVIDER: 'volcengine',
        NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE: settings.cascadedTtsVoice,
        NOVA_AUDIO_AGENT_MODEL_BASE_URL: settings.modelBaseUrl,
        NOVA_AUDIO_AGENT_PLANNER_MODEL: settings.plannerModel,
      })
      const launched = launcher(process.execPath, [entry], {cwd: stateDir, env, stdio: ['ignore', 'ignore', 'pipe']})
      child = launched
      await new Promise((resolve, reject) => {
        const lines = createInterface({input: launched.stderr})
        const timer = setTimeout(() => finish(unavailable('Runtime startup timed out. Check provider settings.')), 30_000)
        function finish(error) { clearTimeout(timer); lines.close(); error ? reject(error) : resolve() }
        lines.on('line', line => { if (line === `[server-ready] ${expectedEndpoint}`) finish() })
        launched.once('error', () => { runtimeStatus = 'failed'; endpoint = null; finish(unavailable('Runtime failed to start.')) })
        launched.once('exit', () => { runtimeStatus = 'failed'; endpoint = null; finish(unavailable('Runtime stopped. Check provider settings.')) })
      })
      // Drain diagnostics without forwarding potentially sensitive provider output.
      launched.stderr.resume()
      endpoint = expectedEndpoint; runtimeStatus = 'ready'
      return endpoint
    } catch (error) {
      try { await stop() } catch (stopError) { throw stopError }
      runtimeStatus = 'failed'
      throw error.code === 'runtime_unavailable' ? error : unavailable('Runtime failed to start. Check provider settings.')
    }
  }
  return {
    token, view, get endpoint() { return endpoint },
    start: () => serial(start),
    update: patch => serial(async () => {
      if (closed) throw unavailable('Web host is closed.')
      if (!record(patch) || Object.keys(patch).some(key => !fields.includes(key) && key !== 'secrets')) throw invalidCommit('invalid_settings_patch')
      const prepared = {...patch}
      if (Object.hasOwn(patch, 'secrets')) {
        if (!record(patch.secrets) || Object.keys(patch.secrets).some(key => !SECRET_KEYS.includes(key))) throw invalidCommit('invalid_secrets')
        prepared.secrets = {}
        for (const [key, value] of Object.entries(patch.secrets)) {
          if (value === null) prepared.secrets[key] = ''
          else if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidCommit('invalid_secrets')
          else if (value.trim()) prepared.secrets[key] = value.trim()
        }
      }
      const next = applySettingsUpdate(settings, prepared)
      validatePreparedSettings(prepared, next)
      if (next.rejectedSecrets.length) throw invalidCommit('invalid_secrets')
      const restart = child !== null
      await saveSettings(settingsFile, next)
      settings = next
      if (restart) {
        try { await stop(); await start() }
        catch (error) { error.saved = true; error.restarted = false; throw error }
      }
      return {...view(), saved: true, restarted: restart}
    }),
    close: () => serial(async () => { closed = true; await stop(); await unlink(tokenFile).catch(error => { if (error.code !== 'ENOENT') throw error }) }),
  }
}
