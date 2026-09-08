import {frontendUsageText} from '../src/renderer/frontend-usage.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {runInNewContext} from 'node:vm'
import * as settingsController from '../src/renderer/settings-controller.mjs'
import {createSecretRevisions} from '../src/renderer/secret-revisions.mjs'
import * as voiceChoice from '../src/renderer/voice-choice.mjs'

const { createSettingsController, mergePatch, settingsButtonState } = settingsController

const html = await readFile(new URL('../src/renderer/settings.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../src/renderer/settings.mjs', import.meta.url), 'utf8')
const controllerScript = await readFile(new URL('../src/renderer/settings-controller.mjs', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/renderer/settings.css', import.meta.url), 'utf8')
const mainScript = await readFile(new URL('../src/main/main.mjs', import.meta.url), 'utf8')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function publicView(overrides = {}) {
  return {
    saved: true,
    palette: 'ember',
    proactivity: 'balanced',
    codexHeartbeatSeconds: 30,
    pipelineMode: 'integrated',
    startListeningOnLaunch: false,
    backendStatus: 'connected',
    backendRetryInMs: null,
    settingsApplyStatus: 'idle',
    integratedProvider: 'qwen',
    integratedModel: 'qwen-realtime',
    integratedVoice: 'longanqian',
    cascadedEndpointingProvider: 'auto',
    cascadedAsrProvider: 'volcengine',
    cascadedLlmProvider: 'qwen',
    cascadedLlmModels: { qwen: 'qwen-flash', ark: 'ark-pro' },
    cascadedTtsProvider: 'volcengine',
    cascadedTtsVoice: 'uranus',
    secretsPresent: {},
    keyringAvailable: true,
    rejectedSecrets: [],
    ...overrides,
  }
}

// Execute the panel's actual event handlers and render path, replacing only
// DOM surfaces and unrelated child panels; controller and value helpers are real.
async function mountSettingsPanel(initialView, apiOverrides = {}) {
  const nodes = new Map()
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      id: selector.slice(1), value: '', textContent: '', hidden: true, dataset: {},
      listeners: {}, append() {},
      addEventListener(event, listener) { this.listeners[event] = listener },
    })
    return nodes.get(selector)
  }
  let push
  runInNewContext(script.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''), {
    ...settingsController, ...voiceChoice, createSecretRevisions, frontendUsageText,
    createCapabilitiesEditor: () => ({render() {}}),
    createKnowledgePanel: () => ({render() {}}),
    document: {
      querySelector: node, querySelectorAll: () => [], getElementById: id => node(`#${id}`),
      createElement: () => ({}), addEventListener() {},
    },
    window: {novaAudioAgentDesktop: {settings: {
      get: async () => initialView, onChanged: listener => { push = listener }, ...apiOverrides,
    }}},
  })
  await new Promise(resolve => setImmediate(resolve))
  return {node, push, click: selector => node(selector).listeners.click()}
}

test('Codex refresh distinguishes recovery and lifecycle refusal from a completed rescan', async () => {
  for (const [operationStatus, expected] of [
    ['recovery_pending', 'Codex 未刷新：请先恢复上次可用设置'],
    ['busy', '另一项操作进行中，Codex 未刷新'],
    [undefined, 'Codex 刷新完成'],
  ]) {
    const view = publicView({operationStatus})
    const panel = await mountSettingsPanel(view, {rescanCodex: async () => view})
    await panel.click('#codex-rescan')
    assert.equal(panel.node('#status').textContent, expected)
  }
})

test('successful recovery clears the prior recovery notice through both pushes and the retry reply', async () => {
  for (const phase of ['recovery_pending', 'recovery_failed']) {
    for (const completion of ['push', 'reply']) {
      const restored = publicView({settingsRecoveryAvailable: false, settingsApplyStatus: 'applied'})
      const panel = await mountSettingsPanel(publicView({
        settingsRecoveryAvailable: true, settingsApplyStatus: phase,
      }), {retryBackend: async () => restored})
      assert.equal(panel.node('#restart-notice').hidden, false)
      assert.notEqual(panel.node('#restart-notice').textContent, '设置已生效')
      if (completion === 'push') panel.push(restored)
      else await panel.click('#settings-restore')
      assert.equal(panel.node('#restart-notice').textContent, '设置已生效')
      assert.equal(panel.node('#settings-restore').hidden, true)
    }
  }
})

test('ordinary applied views and local edits do not introduce a recovery completion notice', async () => {
  const applied = publicView({settingsApplyStatus: 'applied', settingsRecoveryAvailable: false})
  const panel = await mountSettingsPanel(applied)
  assert.equal(panel.node('#restart-notice').hidden, true)
  panel.push(applied)
  panel.node('#integratedModel').value = 'draft-model'
  panel.node('#integratedModel').listeners.input()
  assert.equal(panel.node('#restart-notice').hidden, true)
})

test('rendering a confirmed applied view preserves an unrelated pending restart notice', async () => {
  const panel = await mountSettingsPanel(publicView(), {
    set: async ({settingsPatch}) => publicView({...settingsPatch,
      settingsApplyStatus: 'applied', settingsRecoveryAvailable: false}),
  })
  panel.node('#integratedModel').value = 'saved-model'
  panel.node('#integratedModel').listeners.input()
  panel.click('#settings-save')
  await new Promise(resolve => setImmediate(resolve))
  // No disconnected transition was observed, so the controller still owns a
  // pending restart notice even though its last confirmed reply says applied.
  assert.equal(panel.node('#restart-notice').dataset.state, 'restarting')
  panel.node('#integratedModel').value = 'new-draft-model'
  panel.node('#integratedModel').listeners.input()
  assert.equal(panel.node('#restart-notice').dataset.state, 'restarting')
})

test('a save refused during pending recovery preserves drafts and announces the recovery phase', async () => {
  const notices = []
  const controller = createSettingsController({
    api: {set: async () => publicView({saved: false, settingsRecoveryAvailable: true,
      settingsApplyStatus: 'recovery_pending', operationStatus: 'recovery_pending'})},
    render() {}, status() {}, notice: phase => notices.push(phase),
  })
  controller.setView(publicView())
  controller.stage({palette: 'graphite'})
  assert.equal((await controller.save()).saved, false)
  assert.equal(controller.dirty, true)
  assert.deepEqual(notices, ['recovery_pending'])
})

test('public edits stage locally and one save emits one merged patch', async () => {
  const calls = []
  const renders = []
  const controller = createSettingsController({
    api: {set: async patch => {
      calls.push(structuredClone(patch))
      return publicView({...patch, rejectedSecrets: []})
    }},
    render: (view, drafts, state) => renders.push({view, drafts, state}),
    status: () => {},
  })
  controller.setView(publicView())

  controller.stage({pipelineMode: 'cascaded'})
  controller.stage({cascadedLlmModels: {qwen: 'qwen-plus'}})
  controller.stage({cascadedLlmModels: {ark: 'doubao-pro'}})

  assert.equal(calls.length, 0)
  assert.equal(controller.dirty, true)
  assert.equal(renders.at(-1).view.pipelineMode, 'cascaded')
  assert.deepEqual(renders.at(-1).view.cascadedLlmModels, {
    qwen: 'qwen-plus', ark: 'doubao-pro',
  })

  const result = await controller.save({dashscopeApiKey: 'write-only'})
  assert.deepEqual(calls, [{
    pipelineMode: 'cascaded',
    cascadedLlmModels: {qwen: 'qwen-plus', ark: 'doubao-pro'},
    secrets: {dashscopeApiKey: 'write-only'},
  }])
  assert.equal(result.saved, true)
  assert.deepEqual(result.acceptedSecrets, ['dashscopeApiKey'])
  assert.equal(controller.dirty, false)
})

test('a Main live push updates status without replacing staged values', () => {
  const renders = []
  const controller = createSettingsController({
    api: {set: async () => publicView()},
    render: (view, drafts, state) => renders.push({view, drafts, state}),
    status: () => {},
  })
  controller.setView(publicView())
  controller.stage({pipelineMode: 'cascaded', integratedModel: 'typed-locally'})

  controller.syncView(publicView({
    backendStatus: 'starting',
    pipelineMode: 'integrated',
    integratedModel: 'remote-model',
  }))

  assert.equal(renders.at(-1).view.backendStatus, 'starting')
  assert.equal(renders.at(-1).view.pipelineMode, 'cascaded')
  assert.equal(renders.at(-1).view.integratedModel, 'typed-locally')
  assert.deepEqual(renders.at(-1).drafts, {
    pipelineMode: 'cascaded', integratedModel: 'typed-locally',
  })
})

test('an edit made while save is in flight remains dirty after the older response', async () => {
  const response = deferred()
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => {
      calls.push(structuredClone(patch))
      return response.promise
    }},
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  controller.stage({integratedModel: 'first'})
  const saving = controller.save()
  controller.stage({integratedModel: 'second'})
  response.resolve(publicView({integratedModel: 'first'}))

  await saving
  assert.equal(controller.dirty, true)
  assert.equal(controller.snapshot().view.integratedModel, 'second')
  assert.deepEqual(calls, [{integratedModel: 'first'}])
})

test('a capability edit made during save rebases only to its own accepted revision', async () => {
  const response = deferred()
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => { calls.push(structuredClone(patch)); return response.promise }},
    render: () => {}, status: () => {},
  })
  controller.setView(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 4}, capabilitiesRevision: 'base-revision'}))
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}})
  const first = controller.save()
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 6}})
  response.resolve(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}, capabilitiesRevision: 'saved-revision'}))
  await first
  await controller.save()
  assert.deepEqual(calls.map(call => [call.capabilitiesDocument.frontbrainToolBudget, call.capabilitiesBaseRevision]), [[5, 'base-revision'], [6, 'saved-revision']])
})

test('the Main committed-settings push during save does not block a matching response rebase', async () => {
  const response = deferred()
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => { calls.push(structuredClone(patch)); return response.promise }},
    render: () => {}, status: () => {},
  })
  controller.setView(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 4}, capabilitiesRevision: 'base-revision'}))
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}})
  const first = controller.save()
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 6}})
  controller.syncView(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}, capabilitiesRevision: 'saved-revision'}))
  response.resolve(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}, capabilitiesRevision: 'saved-revision'}))
  await first
  await controller.save()
  assert.equal(calls[1].capabilitiesBaseRevision, 'saved-revision')
})

test('a capability response replaced by an external document never rebases the retained draft', async () => {
  const response = deferred()
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => { calls.push(structuredClone(patch)); return response.promise }},
    render: () => {}, status: () => {},
  })
  controller.setView(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 4}, capabilitiesRevision: 'base-revision'}))
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 5}})
  const first = controller.save()
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 6}})
  controller.syncView(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 7}, capabilitiesRevision: 'external-revision'}))
  response.resolve(publicView({capabilitiesDocument: {version: 1, frontbrainToolBudget: 7}, capabilitiesRevision: 'external-revision'}))
  await first
  await controller.save()
  assert.equal(calls[1].capabilitiesBaseRevision, 'base-revision')
})

test('the complete successful apply sequence clears only the submitted draft', async () => {
  const response = deferred()
  const notices = []
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => { calls.push(structuredClone(patch)); return response.promise }},
    render: () => {},
    status: () => {},
    notice: phase => notices.push(phase),
  })
  controller.setView(publicView())
  controller.stage({palette: 'graphite'})
  assert.equal(calls.length, 0, 'local draft never crosses IPC')
  const saving = controller.save()
  controller.syncView(publicView({settingsApplyStatus: 'saving'}))
  controller.syncView(publicView({settingsApplyStatus: 'restarting', backendStatus: 'starting'}))
  response.resolve(publicView({
    palette: 'graphite', settingsApplyStatus: 'applied', backendStatus: 'connected',
  }))
  assert.equal((await saving).saved, true)
  assert.equal(controller.dirty, false)
  assert.deepEqual(calls, [{palette: 'graphite'}])
  assert.deepEqual(notices, ['restarting', 'complete'])
})

test('an explicitly local-only save does not wait for a backend restart', async () => {
  const notices = []
  const controller = createSettingsController({
    api: {set: async () => publicView({
      wakeWordEnabled: true,
      restarted: false,
      settingsApplyStatus: 'applied',
      backendStatus: 'connected',
    })},
    render: () => {},
    status: () => {},
    notice: phase => notices.push(phase),
  })
  controller.setView(publicView())
  controller.stage({wakeWordEnabled: true})
  assert.equal((await controller.save()).saved, true)
  controller.syncView(publicView({settingsApplyStatus: 'applied', backendStatus: 'connected'}))
  assert.deepEqual(notices, ['complete'])
})

test('a failed restart retains drafts and secrets for recovery', async () => {
  const statuses = []
  const notices = []
  const controller = createSettingsController({
    api: {set: async () => publicView({
      palette: 'graphite',
      saved: false, settingsRecoveryAvailable: true,
      operationStatus: 'restart_failed',
      settingsApplyStatus: 'restart_failed',
    })},
    render: () => {},
    status: value => statuses.push(value),
    notice: phase => notices.push(phase),
  })
  controller.setView(publicView())
  controller.stage({palette: 'graphite'})
  const result = await controller.save({dashscopeApiKey: 'write-only'})
  assert.equal(result.saved, false)
  assert.equal(controller.dirty, true)
  assert.deepEqual(controller.snapshot().drafts, {palette: 'graphite'})
  assert.deepEqual(result.acceptedSecrets, [])
  assert.equal(statuses.at(-1), '未生效，已保留上次设置；请恢复后端')
  assert.deepEqual(notices, ['restart_failed'])
})

test('apply failure retains submitted leaves and newer edits', async () => {
  const response = deferred()
  const controller = createSettingsController({
    api: {set: () => response.promise},
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  controller.stage({
    palette: 'graphite',
    codexHeartbeatSeconds: 45,
    integratedModel: 'submitted-model',
  })
  const saving = controller.save({dashscopeApiKey: 'write-only'})
  controller.stage({integratedModel: 'newer-model'})
  response.resolve(publicView({
    palette: 'graphite',
    codexHeartbeatSeconds: 30,
    integratedModel: 'submitted-model',
    saved: false, settingsRecoveryAvailable: true,
    operationStatus: 'failed',
    settingsApplyStatus: 'failed',
  }))

  const result = await saving
  assert.equal(result.saved, false)
  assert.deepEqual(result.rejectedPublicFields, [])
  assert.deepEqual(result.acceptedSecrets, [])
  assert.deepEqual(controller.snapshot().drafts, {
    palette: 'graphite',
    codexHeartbeatSeconds: 45,
    integratedModel: 'newer-model',
  })
})

test('accepted leaves clear independently while rejected nested leaves stay dirty', async () => {
  const controller = createSettingsController({
    api: {set: async () => publicView({
      pipelineMode: 'cascaded',
      cascadedLlmModels: {qwen: 'qwen-flash', ark: 'ark-new'},
    })},
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  controller.stage({
    pipelineMode: 'cascaded',
    cascadedLlmModels: {qwen: 'too-long', ark: 'ark-new'},
  })

  const result = await controller.save()

  assert.equal(result.saved, false)
  assert.deepEqual(result.rejectedPublicFields, ['cascadedLlmModels.qwen'])
  assert.deepEqual(controller.snapshot().drafts, {
    cascadedLlmModels: {qwen: 'too-long'},
  })
})

test('a dotted public leaf cannot retain an accepted draft through a nested rejection collision', async () => {
  const controller = createSettingsController({
    api: {set: async () => publicView({
      'profile.name': 'accepted-top-level',
      profile: {name: 'old-nested'},
    })},
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView({
    'profile.name': 'old-top-level',
    profile: {name: 'old-nested'},
  }))
  controller.stage({
    'profile.name': 'accepted-top-level',
    profile: {name: 'rejected-nested'},
  })

  const result = await controller.save()

  assert.equal(result.saved, false)
  assert.deepEqual(result.rejectedPublicFields, ['profile.name'])
  assert.deepEqual(controller.snapshot().drafts, {
    profile: {name: 'rejected-nested'},
  })
})

test('a second save is busy and cannot create another bridge call', async () => {
  const response = deferred()
  const calls = []
  const controller = createSettingsController({
    api: {set: patch => {
      calls.push(structuredClone(patch))
      return response.promise
    }},
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  controller.stage({palette: 'graphite'})
  const first = controller.save()

  assert.deepEqual(await controller.save(), {saved: false, status: 'busy'})
  assert.equal(calls.length, 1)
  response.resolve(publicView({palette: 'graphite'}))
  await first
})

test('secret plaintext and direct secret keys never enter public controller state', async () => {
  const snapshots = []
  const calls = []
  const sentinel = 'secret-sentinel-must-not-render'
  const controller = createSettingsController({
    api: {set: async patch => {
      calls.push(structuredClone(patch))
      return publicView({dashscopeApiKey: sentinel})
    }},
    render: (view, drafts, state) => snapshots.push({view, drafts, state}),
    status: () => {},
  })
  controller.setView(publicView({dashscopeApiKey: sentinel}))
  controller.stage({dashscopeApiKey: sentinel})
  await controller.save({dashscopeApiKey: sentinel})

  assert.deepEqual(calls, [{secrets: {dashscopeApiKey: sentinel}}])
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /secret-sentinel|dashscopeApiKey/)
  for (const snapshot of snapshots) {
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-sentinel|dashscopeApiKey/)
  }
})

test('presence booleans stay public while hostile presence accessors are never invoked', async () => {
  let getterCalls = 0
  const hostilePresence = {}
  Object.defineProperties(hostilePresence, {
    dashscopeApiKey: {enumerable: true, value: true},
    tavilyApiKey: {enumerable: true, value: false},
    codexApiKey: {enumerable: true, get() { getterCalls += 1; return true }},
  })
  const controller = createSettingsController({
    api: {set: async () => publicView()},
    render: () => {},
    status: () => {},
  })

  controller.setView(publicView({secretsPresent: hostilePresence}))

  assert.equal(getterCalls, 0)
  assert.deepEqual(controller.snapshot().view.secretsPresent, {
    dashscopeApiKey: true, tavilyApiKey: false,
  })
})

test('the settings page ships the same locked-down CSP as the memory board', () => {
  const board = /* the panel must not loosen anything the board already forbids */ [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'none'",
    "img-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)
  assert.ok(meta, 'the settings page declares a CSP')
  for (const directive of board) assert.ok(meta[1].includes(directive), `CSP keeps ${directive}`)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(html, /<html lang="zh-CN">/)
})

test('the palette control offers both orb palettes with a live swatch', () => {
  assert.match(html, /<input type="radio" name="palette" value="ember"/)
  assert.match(html, /<input type="radio" name="palette" value="graphite"/)
  assert.match(html, /Ember 暖焰/)
  assert.match(html, /Graphite 月光/)
  assert.match(html, /class="swatch swatch-ember"/)
  assert.match(html, /class="swatch swatch-graphite"/)
  // The swatches preview the real orb colours rather than inventing new ones.
  assert.match(css, /#FFB454/i)
  assert.match(css, /#C7CED8/i)
})

test('the proactivity control offers three tiers explained in push-and-pull terms', () => {
  for (const value of ['conservative', 'balanced', 'eager']) {
    assert.match(html, new RegExp(`<input type="radio" name="proactivity" value="${value}"`))
  }
  assert.match(html, /保守/)
  assert.match(html, /均衡/)
  assert.match(html, /积极/)
  const notes = [...html.matchAll(/<span class="option-note">([^<]+)<\/span>/g)].map(m => m[1])
  const proactivityNotes = notes.filter(note => /推|拉/.test(note))
  assert.equal(proactivityNotes.length, 3, 'each tier is explained with push-and-pull wording')
})

test('common choices use compact segmented groups without losing radio semantics', () => {
  for (const id of ['palette', 'proactivity', 'pipeline-mode']) {
    assert.match(html, new RegExp(`<fieldset id="${id}" class="[^"]*segmented[^"]*"`))
  }
  assert.match(css, /\.segmented\s*\{/)
  assert.match(css, /\.segmented label\.choice:has\(:checked\)/)
})

test('the heartbeat slider and model fields carry Main-compatible bounds', () => {
  assert.match(html, /Codex 播报间隔/)
  assert.match(html, /<input type="range" id="heartbeat" min="15" max="120" step="1"/)
  assert.match(html, /Qwen 实时模型/)
  assert.match(html, /<input type="text" id="integratedModel" maxlength="64"/)
  assert.match(html, /<input type="text" id="cascadedLlmModel" maxlength="64"/)
})

test('both voice fields offer presets while keeping a bounded custom id path', () => {
  for (const [preset, custom, label] of [
    ['integratedVoicePreset', 'integratedVoiceCustom', 'Qwen 自定义音色 ID'],
    ['cascadedTtsVoicePreset', 'cascadedTtsVoiceCustom', 'TTS 自定义音色 ID'],
  ]) {
    assert.match(html, new RegExp(`<select id="${preset}"`))
    assert.match(
      html,
      new RegExp(`<input type="text" id="${custom}"[^>]*maxlength="64"[^>]*aria-label="${label}"[^>]*hidden`),
    )
  }
  assert.match(script, /resolveVoiceChoice/)
  assert.match(script, /QWEN_VOICES/)
  assert.match(script, /VOLCENGINE_TTS_VOICES/)
  assert.match(script, /bindVoicePicker\('integratedVoice', integratedVoicePreset, integratedVoiceCustom\)/)
  assert.match(script, /bindVoicePicker\('cascadedTtsVoice', cascadedTtsVoicePreset, cascadedTtsVoiceCustom\)/)
})

test('every API key is a password field with a badge, hint, and clear button', () => {
  for (const key of [
    'dashscopeApiKey',
    'tavilyApiKey',
    'modelApiKey',
    'codexApiKey',
    'arkApiKey',
    'doubaoBigmodelApiKey',
    'doubaoAsrApiKey',
  ]) {
    assert.match(html, new RegExp(`<input type="password" id="${key}"[^>]*placeholder="留空保持不变"`))
    assert.match(html, new RegExp(`<span class="badge" id="badge-${key}">未设置</span>`))
    assert.match(html, new RegExp(`<span class="key-usage" id="usage-${key}">`))
    assert.match(html, new RegExp(`<button type="button" class="clear" data-key="${key}">清除</button>`))
  }
  assert.match(html, /DashScope/)
  assert.match(html, /Tavily/)
  assert.match(html, /模型网关/)
  assert.match(html, /Codex/)
  assert.match(html, /Ark/)
  assert.match(html, /豆包大模型/)
  assert.match(html, /豆包 ASR/)
  assert.equal((html.match(/type="password"/g) || []).length, 7)
})

test('API keys live in a collapsed semantic disclosure with a readable summary', () => {
  assert.match(html, /<details id="secrets" class="secret-disclosure">/)
  assert.match(html, /<summary>[\s\S]*API 密钥[\s\S]*按需展开[\s\S]*<\/summary>/)
  assert.doesNotMatch(html, /<details id="secrets"[^>]*\sopen(?:\s|>)/)
})

test('the compact theme preserves motion contrast and forced-color accessibility', () => {
  assert.match(css, /color-scheme:\s*light/)
  assert.doesNotMatch(css, /color-scheme:\s*dark/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /@media \(prefers-contrast: more\)/)
  assert.match(css, /@media \(forced-colors: active\)/)
})

test('pipeline selection shows the integrated path or the cascaded nodes', () => {
  assert.match(html, /<input type="radio" name="pipelineMode" value="integrated">/)
  assert.match(html, /<input type="radio" name="pipelineMode" value="cascaded">/)
  assert.match(html, /<section id="integrated-pipeline">/)
  assert.match(html, /<section id="cascaded-pipeline" hidden>/)
  for (const id of [
    'cascadedEndpointingProvider',
    'cascadedAsrProvider',
    'cascadedLlmProvider',
    'cascadedLlmModel',
    'cascadedTtsProvider',
    'cascadedTtsVoicePreset',
    'cascadedTtsVoiceCustom',
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(script, /integratedSection\.hidden = view\.pipelineMode !== 'integrated'/)
  assert.match(script, /cascadedSection\.hidden = view\.pipelineMode !== 'cascaded'/)
})

test('the active cascaded model follows its provider and preserves the other model', () => {
  assert.match(script, /cascadedLlmModels: \{ \[provider\]: value \}/)
  assert.deepEqual(
    mergePatch(
      {cascadedLlmModels: {qwen: 'qwen-old', ark: 'ark-old'}},
      {cascadedLlmModels: {qwen: 'qwen-new'}},
    ),
    {cascadedLlmModels: {qwen: 'qwen-new', ark: 'ark-old'}},
  )
})

test('key usage labels are derived from public pipeline selection only', () => {
  assert.match(script, /function keyUsage\(view\)/)
  assert.match(script, /dashscopeApiKey: view\.pipelineMode === 'integrated'/)
  assert.match(script, /arkApiKey: view\.pipelineMode === 'cascaded'/)
  assert.match(script, /doubaoBigmodelApiKey: view\.pipelineMode === 'cascaded'/)
  assert.match(script, /doubaoAsrApiKey: view\.pipelineMode === 'cascaded'/)
  assert.doesNotMatch(script, /\.secrets\b|ciphertext|decrypt/)
})

test('the panel states what applies immediately and what triggers a controlled reconnect', () => {
  assert.match(html, /更改会暂存在本窗口/)
  assert.match(html, /保存并重启/)
  assert.match(html, /<p id="restart-notice" class="warning" hidden><\/p>/)
  assert.match(script, /已保存，后台正在重启并重新连接/u)
  assert.match(script, /设置已生效/u)
  assert.match(script, /未生效：请恢复上次可用设置/u)
  assert.match(script, /后端未启动：上次设置已保留/u)
  assert.doesNotMatch(controllerScript, /已保存·(?:未生效|后端未启动)/u)
  assert.match(controllerScript, /announce\('complete'\)/)
  assert.match(html, /<p id="keyring-warning"[^>]*hidden[^>]*>密钥将以明文保存\(系统未提供钥匙串\)<\/p>/)
})

test('settings preserve approval, planning, and progress controls alongside the capability editor', () => {
  for (const value of ['ask', 'yolo']) {
    assert.match(html, new RegExp(`<input type="radio" name="codexApprovalMode" value="${value}"`))
  }
  assert.match(html, /id="codex-yolo-warning"[^>]*hidden/u)
  for (const value of ['minimal', 'balanced', 'thorough']) {
    assert.match(html, new RegExp(`<option value="${value}"`))
  }
  for (const value of ['summary', 'confirm', 'silent']) {
    assert.match(html, new RegExp(`<input type="radio" name="planReadback" value="${value}"`))
  }
  assert.match(html, /id="plannerModel"/)
  for (const value of ['off', 'milestones', 'all']) {
    assert.match(html, new RegExp(`<input type="radio" name="progressBubbles" value="${value}"`))
  }
  assert.match(script, /codexApprovalModeInputs/)
  assert.match(script, /yoloWarning\.hidden = view\.codexApprovalMode !== 'yolo'/)
  assert.match(script, /plannerModel\.value = view\.plannerModel/u)
  assert.doesNotMatch(html, /searchProvider|MCP 服务器|MCP 编辑器/u)
})

test('automatic discovery hides manual Codex and Projects configuration', () => {
  assert.deepEqual(settingsController.codexModeVisibility?.('auto'), {
    manualConfigurationHidden: true,
    rescanHidden: false,
  })
})

test('manual discovery exposes Codex and Projects configuration without rescan', () => {
  assert.deepEqual(settingsController.codexModeVisibility?.('manual'), {
    manualConfigurationHidden: false,
    rescanHidden: true,
  })
})

test('Codex and Projects is the final collapsed settings disclosure', () => {
  const disclosure = html.match(/<details id="codex-projects"[\s\S]*<\/details>\s*<\/main>/)?.[0]
  assert.ok(disclosure, 'Codex and Projects closes the settings content')
  assert.doesNotMatch(disclosure, /<details id="codex-projects"[^>]*\sopen(?:\s|>)/)
  assert.match(disclosure, /<div id="codex-manual-settings"[^>]*hidden>/)
  assert.match(disclosure, /Codex 与 Projects/)
})

test('the panel exposes packaged Codex, Projects, and model endpoint configuration', () => {
  for (const id of [
    'codex-status',
    'codexBinaryPath',
    'codex-rescan',
    'codexWorkspace',
    'codexManagedRoot',
    'modelBaseUrl',
    'effective-workspace',
    'effective-managed-root',
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /name="codexBinaryMode" value="auto"/)
  assert.match(html, /name="codexBinaryMode" value="manual"/)
  assert.match(html, /id="projects-repair"/)
  assert.match(script, /api\.repairProjects\(root\)/)
  assert.match(script, /api\.rescanCodex\(\)/)
  assert.match(script, /codexModeVisibility\(view\.codexBinaryMode\)/)
  assert.doesNotMatch(html, /codexProjectsEnabled/)
  assert.doesNotMatch(script, /codexProjectsEnabled/)
  assert.match(script, /\(\{codexWorkspace: codexWorkspace\.value\}\)/)
  assert.match(script, /\(\{codexManagedRoot: codexManagedRoot\.value\}\)/)
  assert.match(script, /\(\{modelBaseUrl: modelBaseUrl\.value\}\)/)
})

test('workspace actions use refresh wording and omit managed terminology from UI copy', () => {
  assert.match(html, /id="codex-rescan">刷新<\/button>/u)
  assert.match(html, />打开当前 workspace<\/button>/u)
  assert.match(html, />清空当前 workspace<\/button>/u)
  assert.match(html, />清空全部 workspace<\/button>/u)
  assert.match(script, /正在刷新 Codex/u)
  assert.match(script, /Codex 刷新完成/u)
  assert.doesNotMatch(html, /重新扫描|托管/u)
  assert.doesNotMatch(script, /重新扫描|托管/u)
})

test('the optional model gateway address is grouped with its API key', () => {
  const secretsStart = html.indexOf('<details id="secrets"')
  const secretsEnd = html.indexOf('</details>', secretsStart)
  const baseUrl = html.indexOf('id="modelBaseUrl"')
  const modelKey = html.indexOf('id="modelApiKey"')
  assert.ok(secretsStart >= 0 && secretsEnd > secretsStart)
  assert.ok(baseUrl > secretsStart && baseUrl < secretsEnd)
  assert.ok(modelKey > secretsStart && modelKey < secretsEnd)
  assert.doesNotMatch(html, /<h2>模型连接<\/h2>/)
  assert.match(html, /模型网关地址（高级）/)
  assert.match(html, /留空使用 DashScope 默认地址/)
  assert.match(html, /FastBrain/)
})

test('the panel omits the connection and microphone block while launch listening stays automatic', () => {
  assert.doesNotMatch(html, /连接与麦克风/)
  assert.doesNotMatch(html, /id="backend-status"/)
  assert.doesNotMatch(html, /id="backend-retry"/)
  assert.doesNotMatch(html, /id="microphone-status"/)
  assert.doesNotMatch(html, /id="microphone-retry"/)
  assert.doesNotMatch(html, /id="startListeningOnLaunch"/)
  assert.doesNotMatch(html, /启动时自动开始监听/)
  assert.doesNotMatch(script, /document\.querySelector\('#backend-status'\)/)
  assert.doesNotMatch(script, /document\.querySelector\('#microphone-status'\)/)
  assert.match(script, /api\.retryBackend\(\)/)
  assert.doesNotMatch(script, /api\.retryMicrophone\(\)/)
  assert.doesNotMatch(script, /startListeningOnLaunch/)
})

test('the panel talks to main only through the settings bridge', () => {
  assert.match(script, /window\.novaAudioAgentDesktop\.settings/)
  assert.doesNotMatch(script, /fetch\(|WebSocket|memoryBoard|bootstrap/)
  assert.doesNotMatch(html, /<script(?![^>]*src="\.\/settings\.mjs")/)
})

test('the panel writes secrets forward only and never reads a value back', () => {
  // Password fields are cleared after a successful save and never repopulated,
  // because main answers with presence booleans and no key material at all.
  assert.match(script, /secretsPresent/)
  assert.match(script, /已设置/)
  assert.match(script, /未设置/)
  assert.match(script, /secretRevisions\.matches\(key, input\.value, submissions\[key\]\)/)
  assert.match(script, /result\.acceptedSecrets/)
  assert.doesNotMatch(script, /\.secrets\b|\.data\b|decrypt/)
})

test('the keyring warning is driven by the flag main reports', () => {
  // Shown only when main explicitly says the keyring is unavailable: a missing
  // flag is not evidence of plaintext storage, so it must not raise the alarm.
  assert.match(script, /warning\.hidden = view\.keyringAvailable !== false/)
})

test('all editable settings stage until the single save action', () => {
  assert.match(script, /addEventListener\('change'/)
  assert.match(script, /input\[name="palette"\]/)
  assert.match(script, /\(\{palette: input\.value\}\)/)
  assert.match(html, /id="settings-save"[^>]*>保存并重启<\/button>/)
  assert.doesNotMatch(script, /saveText\(|controller\.push\(|save-secrets/)
  assert.match(script, /button\.clear/)
})

test('save and workspace buttons reflect dirtiness, lifecycle, and target eligibility', () => {
  assert.deepEqual(settingsButtonState({
    dirty: true,
    controllerBusy: false,
    lifecycleBusy: false,
    currentManagedAvailable: true,
    allManagedAvailable: true,
  }), {
    saveDisabled: false,
    workspaceDisabled: false,
    currentDisabled: false,
    recoveryDisabled: true,
  })
  assert.deepEqual(settingsButtonState({
    dirty: false,
    controllerBusy: false,
    lifecycleBusy: false,
    currentManagedAvailable: false,
    allManagedAvailable: true,
  }), {
    saveDisabled: true,
    workspaceDisabled: false,
    currentDisabled: true,
    recoveryDisabled: true,
  })
  for (const busyField of ['controllerBusy', 'lifecycleBusy', 'workspaceBusy']) {
    assert.deepEqual(settingsButtonState({
      dirty: true,
      controllerBusy: false,
      lifecycleBusy: false,
      workspaceBusy: false,
      currentManagedAvailable: true,
      allManagedAvailable: true,
      [busyField]: true,
    }), {
      saveDisabled: true,
      workspaceDisabled: true,
      currentDisabled: true,
      recoveryDisabled: true,
    })
  }
  assert.deepEqual(settingsButtonState({
    dirty: false,
    controllerBusy: false,
    lifecycleBusy: false,
    currentManagedAvailable: false,
    allManagedAvailable: false,
  }), {
    saveDisabled: true,
    workspaceDisabled: true,
    currentDisabled: true,
    recoveryDisabled: true,
  })
  assert.deepEqual(settingsButtonState({
    dirty: true,
    controllerBusy: false,
    lifecycleBusy: false,
    managedHealth: 'rollback_pending',
    managedRecoveryStatus: 'required',
    currentManagedAvailable: true,
    allManagedAvailable: true,
  }), {
    saveDisabled: false,
    workspaceDisabled: true,
    currentDisabled: true,
    recoveryDisabled: false,
  })
  for (const managedRecoveryStatus of ['required', 'failed']) {
    assert.deepEqual(settingsButtonState({
      dirty: false,
      controllerBusy: false,
      lifecycleBusy: false,
      managedHealth: 'ready',
      managedRecoveryStatus,
      currentManagedAvailable: true,
      allManagedAvailable: true,
    }), {
      saveDisabled: true,
      workspaceDisabled: true,
      currentDisabled: true,
      recoveryDisabled: false,
    })
  }
})

test('one save clears only accepted secrets whose input revision is unchanged', () => {
  assert.match(script, /const result = await controller\.save\(stagedSecrets\(\)\)/)
  assert.match(script, /for \(const key of result\.acceptedSecrets \?\? \[\]\) \{/)
  assert.match(script, /if \(secretRevisions\.matches\(key, input\.value, submissions\[key\]\)\) \{/)
})

test('one save names any rejected secret by its panel label', () => {
  assert.match(script, /const SECRET_LABELS = \{/)
  assert.match(script, /dashscopeApiKey: 'DashScope',/)
  assert.match(script, /tavilyApiKey: 'Tavily',/)
  assert.match(script, /modelApiKey: '模型网关',/)
  assert.match(script, /codexApiKey: 'Codex',/)
  assert.match(script, /arkApiKey: 'Ark',/)
  assert.match(script, /doubaoBigmodelApiKey: '豆包大模型',/)
  assert.match(script, /doubaoAsrApiKey: '豆包 ASR',/)
  // Each exact queued request retains its own rejection list. The renderer
  // names only keys this save submitted, so a coalesced neighbour cannot make
  // a different field's error appear in its status line.
  assert.match(script, /if \(result\.rejectedSecrets\.length\) \{/)
  assert.match(
    script,
    /statusLabel\.textContent = `部分密钥未保存\(含非法字符\): \$\{labels\.join\('、'\)\}`/,
  )
  assert.match(
    script,
    /const labels = result\.rejectedSecrets\.map\(key => SECRET_LABELS\[key\]\)/,
  )
})

test('workspace controls expose only zero-argument managed actions', () => {
  for (const id of [
    'workspace-open-current',
    'workspace-clear-current',
    'workspace-clear-all',
    'workspace-retry-recovery',
    'workspace-action-status',
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(script, /api\.openCurrentManagedWorkspace\(\)/)
  assert.match(script, /api\.clearCurrentManagedWorkspace\(\)/)
  assert.match(script, /api\.clearAllManagedWorkspaces\(\)/)
  assert.match(script, /api\.retryBackend\(\)/)
  assert.match(script, /managedWorkspaces\?\.recoveryStatus/)
  assert.match(script, /recoveryStatus === 'idle'/)
  assert.match(html, /<\/div>\n\s*<div class="workspace-actions">/)
  const statusText = script.slice(
    script.indexOf('const WORKSPACE_STATUS_TEXT'),
    script.indexOf('\n})', script.indexOf('const WORKSPACE_STATUS_TEXT')) + 3,
  )
  assert.doesNotMatch(statusText, /(?:file:|[A-Za-z]:\\|\/(?:Users|home|var|tmp)\/)/u)
})

test('the Orb receives one committed palette notification only inside the save transaction', () => {
  const notifications = mainScript.match(
    /'nova:settings:changed', orbSettings\(currentSettings\)/g,
  ) ?? []
  assert.equal(notifications.length, 1)
  const handler = mainScript.slice(mainScript.indexOf("ipcMain.handle('nova:settings:set'"))
  const body = handler.slice(0, handler.indexOf('\n  })'))
  assert.match(body, /publishCommitted: publishCommittedSettings/)
  assert.ok(body.indexOf('write: async value') < body.indexOf('publishCommitted:'))
})

test('capability documents replace atomically, preserve original special tool names and server deletion', async () => {
  const {createSettingsController} = await import('../src/renderer/settings-controller.mjs')
  let outbound
  const controller = createSettingsController({api: {set: async patch => {outbound = patch; return {...patch, saved: true, settingsApplyStatus: 'applied'}}}, render: () => {}, status: () => {}})
  controller.setView({capabilitiesDocument: {version: 1, mcpServers: {old: {tools: {}}}}, capabilitiesRevision: 'original-revision'})
  const document = JSON.parse('{"version":1,"mcpServers":{"demo":{"tools":{"__proto__":{"enabled":true},"lookup.raw":{"enabled":true}}}}}')
  controller.stage({capabilitiesDocument: document})
  controller.syncView({capabilitiesDocument: {version: 1, mcpServers: {external: {tools: {}}}}, capabilitiesRevision: 'newer-revision'})
  await controller.save()
  assert.deepEqual(outbound.capabilitiesDocument, document)
  assert.equal(outbound.capabilitiesBaseRevision, 'original-revision')
  assert.equal(Object.hasOwn(outbound.capabilitiesDocument.mcpServers.demo.tools, '__proto__'), true)
  controller.stage({capabilitiesDocument: {version: 1, mcpServers: {}}})
  await controller.save()
  assert.deepEqual(outbound.capabilitiesDocument.mcpServers, {})
})

test('a stale capability document keeps its draft and asks the user to reopen settings', async () => {
  const {createSettingsController} = await import('../src/renderer/settings-controller.mjs')
  let note = ''
  const controller = createSettingsController({
    api: {set: async () => ({saved: false, operationStatus: 'invalid', problems: ['capabilities_document_changed']})},
    render: () => {}, status: value => {note = value},
  })
  controller.setView({capabilitiesDocument: {version: 1}, capabilitiesRevision: 'original-revision'})
  controller.stage({capabilitiesDocument: {version: 1, frontbrainToolBudget: 6}})
  assert.equal((await controller.save()).saved, false)
  assert.equal(controller.snapshot().dirty, true)
  assert.match(note, /关闭并重新打开设置/u)
})

test('failed application exposes recovery without clearing unsaved drafts or accepting secret changes', async () => {
  const {createSettingsController} = await import('../src/renderer/settings-controller.mjs')
  const controller = createSettingsController({
    api: {set: async () => ({integratedModel: 'previous-model', saved: false,
      settingsApplyStatus: 'restart_failed', settingsRecoveryAvailable: true})},
    render: () => {}, status: () => {},
  })
  controller.setView({integratedModel: 'previous-model'})
  controller.stage({integratedModel: 'bad-model'})
  const result = await controller.save({dashscopeApiKey: 'new-key'})
  assert.equal(result.saved, false)
  assert.deepEqual(result.acceptedSecrets, [])
  assert.equal(controller.snapshot().dirty, true)
  assert.equal(controller.snapshot().view.settingsRecoveryAvailable, true)
  assert.equal(controller.snapshot().view.integratedModel, 'bad-model')
  assert.match(html, /id="settings-restore" hidden>恢复上次可用设置/)
  assert.match(script, /settingsRestore\.addEventListener\('click',[\s\S]*api\.retryBackend\(\)/)
})


test('usage stays current through a stale save reply and renders a compact summary', async () => {
  const response = deferred()
  const renders = []
  const controller = createSettingsController({api: {set: () => response.promise}, render: view => renders.push(view), status: () => {}})
  const usage = {requests: 2, costCny: 0.12, pricedReports: 2, missingReports: 0, unpricedReports: 0, rows: [], priceDate: '2026-09-08'}
  controller.setView(publicView({frontendUsage: {...usage, requests: 1}}))
  controller.stage({palette: 'graphite'})
  const saving = controller.save()
  controller.syncView(publicView({frontendUsage: usage}))
  response.resolve(publicView({frontendUsage: {...usage, requests: 1}, restarted: false}))
  await saving
  assert.equal(renders.at(-1).frontendUsage.requests, 2)
  const panel = await mountSettingsPanel(publicView({frontendUsage: usage}))
  assert.match(panel.node('#frontend-usage').textContent, /¥0.120000/)
  assert.doesNotMatch(panel.node('#frontend-usage').textContent, /官方按量/)
  assert.match(panel.node('#frontend-usage-details').textContent, /官方按量/)
})
