import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createSettingsController } from '../src/renderer/settings-controller.mjs'
import { createSecretRevisions } from '../src/renderer/secret-revisions.mjs'

const html = await readFile(new URL('../src/renderer/settings.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../src/renderer/settings.mjs', import.meta.url), 'utf8')
const controllerScript = await readFile(new URL('../src/renderer/settings-controller.mjs', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/renderer/settings.css', import.meta.url), 'utf8')

const ALL_SECRET_KEYS = [
  'dashscopeApiKey',
  'tavilyApiKey',
  'modelApiKey',
  'codexApiKey',
  'arkApiKey',
  'doubaoBigmodelApiKey',
  'doubaoAsrApiKey',
]

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
    backendStatus: 'ready',
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

test('queued secret saves wait for their own bridge response and retain its rejection', async () => {
  const first = deferred()
  const second = deferred()
  const calls = []
  const controller = createSettingsController({
    api: { set: patch => {
      calls.push(patch)
      return calls.length === 1 ? first.promise : second.promise
    } },
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  const revisions = createSecretRevisions(['dashscopeApiKey', 'arkApiKey'])
  revisions.noteInput('dashscopeApiKey')
  const firstSubmission = revisions.capture('dashscopeApiKey', 'first-key')
  const firstSave = controller.saveSecrets({ dashscopeApiKey: firstSubmission.value })
  revisions.noteInput('arkApiKey')
  const queuedSubmission = revisions.capture('arkApiKey', 'bad-key')
  const queuedSave = controller.saveSecrets({ arkApiKey: queuedSubmission.value })
  first.resolve(publicView())
  const firstResult = await firstSave
  assert.deepEqual(firstResult.accepted, ['dashscopeApiKey'])
  assert.ok(revisions.matches('dashscopeApiKey', 'first-key', firstSubmission))
  assert.equal(calls.length, 2, 'the queued caller begins only after the first response')
  second.resolve(publicView({ rejectedSecrets: ['arkApiKey'] }))
  const queuedResult = await queuedSave
  assert.deepEqual(queuedResult.rejected, ['arkApiKey'])
  assert.ok(revisions.matches('arkApiKey', 'bad-key', queuedSubmission), 'rejection leaves the value in place')
})

test('an earlier accepted secret response cannot clear a newer value in that field', async () => {
  const pending = deferred()
  const controller = createSettingsController({
    api: { set: () => pending.promise },
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  const revisions = createSecretRevisions(['dashscopeApiKey'])
  revisions.noteInput('dashscopeApiKey')
  const oldSubmission = revisions.capture('dashscopeApiKey', 'old-key')
  const firstSave = controller.saveSecrets({ dashscopeApiKey: oldSubmission.value })
  revisions.noteInput('dashscopeApiKey')
  pending.resolve(publicView())
  const result = await firstSave
  assert.deepEqual(result.accepted, ['dashscopeApiKey'])
  assert.ok(!revisions.matches('dashscopeApiKey', 'new-key', oldSubmission), 'the newer plaintext must remain')
})

test('secret values and key names never enter controller render drafts', async () => {
  const accepted = deferred()
  const rejected = deferred()
  const failed = deferred()
  const snapshots = []
  const calls = []
  const controller = createSettingsController({
    api: { set: patch => {
      calls.push(patch)
      return [accepted.promise, rejected.promise, failed.promise][calls.length - 1]
    } },
    render: (view, drafts) => snapshots.push({ view, drafts }),
    status: () => {},
  })
  const sentinel = 'secret-sentinel-must-not-render'
  controller.setView(publicView())
  controller.setDraft('dashscopeApiKey', sentinel)
  const acceptedSave = controller.saveSecrets({ dashscopeApiKey: sentinel })
  accepted.resolve(publicView())
  await acceptedSave
  const rejectedSave = controller.saveSecrets({ arkApiKey: sentinel })
  rejected.resolve(publicView({ rejectedSecrets: ['arkApiKey'] }))
  await rejectedSave
  const failedSave = controller.saveSecrets({ codexApiKey: sentinel })
  failed.reject(new Error('bridge unavailable'))
  await failedSave
  for (const snapshot of snapshots) {
    const rendered = JSON.stringify(snapshot)
    assert.doesNotMatch(rendered, /secret-sentinel-must-not-render/)
    for (const key of ['dashscopeApiKey', 'arkApiKey', 'codexApiKey']) {
      assert.ok(!(key in snapshot.drafts), `draft snapshot excludes ${key}`)
    }
  }
})

test('all seven presence booleans survive initial and confirmed public views', async () => {
  const initialPresence = {
    dashscopeApiKey: true,
    tavilyApiKey: false,
    modelApiKey: true,
    codexApiKey: false,
    arkApiKey: true,
    doubaoBigmodelApiKey: false,
    doubaoAsrApiKey: true,
  }
  const confirmedPresence = {
    dashscopeApiKey: false,
    tavilyApiKey: true,
    modelApiKey: false,
    codexApiKey: true,
    arkApiKey: false,
    doubaoBigmodelApiKey: true,
    doubaoAsrApiKey: false,
  }
  const renders = []
  const controller = createSettingsController({
    api: { set: async () => publicView({ secretsPresent: confirmedPresence }) },
    render: view => renders.push(view),
    status: () => {},
  })

  controller.setView(publicView({ secretsPresent: initialPresence }))
  assert.deepEqual(renders.at(-1).secretsPresent, initialPresence)

  const result = await controller.push({ palette: 'graphite' }, '配色已更新')
  assert.deepEqual(result.view.secretsPresent, confirmedPresence)
  assert.deepEqual(renders.at(-1).secretsPresent, confirmedPresence)
})

test('presence metadata keeps only known own boolean data properties without invoking getters', async () => {
  let getterCalls = 0
  const hostilePresence = Object.create({ dashscopeApiKey: true })
  Object.defineProperties(hostilePresence, {
    tavilyApiKey: { enumerable: true, value: false },
    modelApiKey: { enumerable: true, value: true },
    codexApiKey: {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'accessor-secret'
      },
    },
    arkApiKey: { enumerable: true, value: 'plaintext-secret' },
    doubaoBigmodelApiKey: { enumerable: true, value: null },
    doubaoAsrApiKey: { enumerable: true, value: 1 },
    extra: { enumerable: true, value: 'extra-secret' },
  })
  const expected = { tavilyApiKey: false, modelApiKey: true }
  const renders = []
  const controller = createSettingsController({
    api: { set: async () => publicView({ secretsPresent: hostilePresence }) },
    render: view => renders.push(view),
    status: () => {},
  })

  controller.setView(publicView({ secretsPresent: hostilePresence }))
  assert.equal(getterCalls, 0)
  assert.deepEqual(renders.at(-1).secretsPresent, expected)

  const result = await controller.push({ palette: 'graphite' }, '配色已更新')
  assert.equal(getterCalls, 0)
  assert.deepEqual(result.view.secretsPresent, expected)
  assert.deepEqual(renders.at(-1).secretsPresent, expected)
  assert.doesNotMatch(JSON.stringify(renders), /accessor-secret|plaintext-secret|extra-secret/)
})

test('every public controller boundary strips all secret keys without touching legitimate nested state', async () => {
  const sentinel = 'hostile-secret-sentinel'
  for (const key of ALL_SECRET_KEYS) {
    const snapshots = []
    const calls = []
    const controller = createSettingsController({
      api: { set: async patch => {
        calls.push(patch)
        return publicView({ [key]: sentinel })
      } },
      render: (view, drafts) => snapshots.push({ view, drafts }),
      status: () => {},
    })
    controller.setView(publicView({ [key]: sentinel }))
    controller.setDraft(key, sentinel)
    controller.applyLocal({ [key]: sentinel })
    await controller.push({ [key]: sentinel }, '已保存')
    assert.ok(!(key in calls[0]), `push removes top-level ${key} before the bridge`)
    for (const snapshot of snapshots) {
      const rendered = JSON.stringify(snapshot)
      assert.doesNotMatch(rendered, /hostile-secret-sentinel/)
      assert.ok(!(key in snapshot.view), `view excludes ${key}`)
      assert.ok(!(key in snapshot.drafts), `drafts exclude ${key}`)
    }
  }

  const calls = []
  const snapshots = []
  const controller = createSettingsController({
    api: { set: async patch => {
      calls.push(patch)
      return publicView({ cascadedLlmModels: { qwen: 'qwen-new', ark: 'ark-new' } })
    } },
    render: (view, drafts) => snapshots.push({ view, drafts }),
    status: () => {},
  })
  controller.setView(publicView())
  controller.applyLocal({ cascadedLlmModels: { ark: 'ark-new' } })
  assert.equal(snapshots.at(-1).view.cascadedLlmModels.ark, 'ark-new')
  await controller.push({ secrets: { dashscopeApiKey: sentinel } }, '密钥已保存')
  assert.deepEqual(calls[0], { secrets: { dashscopeApiKey: sentinel } })
  await controller.push({ cascadedLlmModels: { qwen: 'qwen-new' } }, '已保存')
  assert.deepEqual(calls[1], { cascadedLlmModels: { qwen: 'qwen-new' } })
})

test('a dirty text draft survives a stale response and can be saved afterwards', async () => {
  const first = deferred()
  const second = deferred()
  const calls = []
  const renders = []
  const controller = createSettingsController({
    api: { set: patch => {
      calls.push(patch)
      return calls.length === 1 ? first.promise : second.promise
    } },
    render: (view, drafts) => renders.push({ view, drafts }),
    status: () => {},
  })
  controller.setView(publicView())
  const savePalette = controller.push({ palette: 'graphite' }, '配色已更新')
  controller.setDraft('integratedModel', 'typed-later')
  const saveModel = controller.push({ integratedModel: 'typed-later' }, '已保存')
  first.resolve(publicView({ palette: 'graphite', integratedModel: 'stale-server-value' }))
  await savePalette
  assert.equal(renders.at(-1).drafts.integratedModel, 'typed-later')
  assert.deepEqual(calls[1], { integratedModel: 'typed-later' })
  second.resolve(publicView({ palette: 'graphite', integratedModel: 'typed-later' }))
  await saveModel
  assert.equal(controller.getDraft('integratedModel'), undefined)
})

test('pipeline and provider selections render locally before their deferred save', () => {
  const renders = []
  const controller = createSettingsController({
    api: { set: () => new Promise(() => {}) },
    render: (view) => renders.push(view),
    status: () => {},
  })
  controller.setView(publicView())
  controller.applyLocal({ pipelineMode: 'cascaded' })
  controller.applyLocal({ cascadedLlmProvider: 'ark' })
  const immediate = renders.at(-1)
  assert.equal(immediate.pipelineMode, 'cascaded')
  assert.equal(immediate.cascadedLlmProvider, 'ark')
  assert.equal(immediate.cascadedLlmModels.ark, 'ark-pro')
})

test('nested queued model patches retain both provider leaves', async () => {
  const first = deferred()
  const second = deferred()
  const calls = []
  const controller = createSettingsController({
    api: { set: patch => {
      calls.push(patch)
      return calls.length === 1 ? first.promise : second.promise
    } },
    render: () => {},
    status: () => {},
  })
  controller.setView(publicView())
  const palette = controller.push({ palette: 'graphite' }, '配色已更新')
  const qwen = controller.push({ cascadedLlmModels: { qwen: 'qwen-new' } }, '已保存')
  const ark = controller.push({ cascadedLlmModels: { ark: 'ark-new' } }, '已保存')
  first.resolve(publicView({ palette: 'graphite' }))
  await palette
  assert.deepEqual(calls[1], { cascadedLlmModels: { qwen: 'qwen-new', ark: 'ark-new' } })
  second.resolve(publicView({
    palette: 'graphite',
    cascadedLlmModels: { qwen: 'qwen-new', ark: 'ark-new' },
  }))
  await Promise.all([qwen, ark])
})

test('a failed optimistic pipeline and provider write rolls back and the next batch retries', async () => {
  const failure = deferred()
  const retry = deferred()
  const calls = []
  const renders = []
  const controller = createSettingsController({
    api: { set: patch => {
      calls.push(patch)
      return calls.length === 1 ? failure.promise : retry.promise
    } },
    render: (view, drafts) => renders.push({ view, drafts }),
    status: () => {},
  })
  controller.setView(publicView())
  controller.setDraft('integratedModel', 'keep-this-draft')
  const patch = { pipelineMode: 'cascaded', cascadedLlmProvider: 'ark' }
  controller.applyLocal(patch)
  const failedWrite = controller.push(patch, '语音管线已保存')
  failure.reject(new Error('bridge unavailable'))
  const failedResult = await failedWrite
  assert.equal(failedResult.saved, false)
  assert.equal(renders.at(-1).view.pipelineMode, 'integrated')
  assert.equal(renders.at(-1).view.cascadedLlmProvider, 'qwen')
  assert.equal(renders.at(-1).drafts.integratedModel, 'keep-this-draft')
  const successfulRetry = controller.push(patch, '语音管线已保存')
  assert.equal(calls.length, 2, 'a failed flush releases the queue for a retry')
  retry.resolve(publicView(patch))
  const retryResult = await successfulRetry
  assert.equal(retryResult.saved, true)
  assert.equal(renders.at(-1).view.pipelineMode, 'cascaded')
  assert.equal(renders.at(-1).view.cascadedLlmProvider, 'ark')
})

test('normalized public-field rejections are not reported as saved and retain retryable drafts',
  async () => {
    const tooLong = 'x'.repeat(65)
    const responses = [
      publicView({ integratedModel: 'qwen-realtime' }),
      publicView({ integratedModel: 'qwen-retry' }),
      publicView({ cascadedLlmModels: {qwen: 'qwen-flash', ark: 'ark-pro'} }),
      publicView({ cascadedLlmModels: {qwen: 'qwen-retry', ark: 'ark-pro'} }),
    ]
    const statuses = []
    const controller = createSettingsController({
      api: { set: async () => responses.shift() },
      render: () => {},
      status: note => statuses.push(note),
    })
    controller.setView(publicView())

    controller.setDraft('integratedModel', tooLong)
    controller.applyLocal({integratedModel: tooLong})
    const rejectedTopLevel = await controller.push({integratedModel: tooLong}, '已保存')
    assert.equal(rejectedTopLevel.saved, false)
    assert.deepEqual(rejectedTopLevel.rejectedPublicFields, ['integratedModel'])
    assert.equal(controller.getDraft('integratedModel'), tooLong)
    assert.equal(statuses.at(-1), '部分设置未保存')

    controller.setDraft('integratedModel', 'qwen-retry')
    controller.applyLocal({integratedModel: 'qwen-retry'})
    const acceptedTopLevel = await controller.push({integratedModel: 'qwen-retry'}, '已保存')
    assert.equal(acceptedTopLevel.saved, true)
    assert.deepEqual(acceptedTopLevel.rejectedPublicFields, [])
    assert.equal(controller.getDraft('integratedModel'), undefined)

    const nestedDraft = 'cascadedLlmModel:qwen'
    controller.setDraft(nestedDraft, tooLong)
    controller.applyLocal({cascadedLlmModels: {qwen: tooLong}})
    const rejectedNested = await controller.push({cascadedLlmModels: {qwen: tooLong}}, '已保存')
    assert.equal(rejectedNested.saved, false)
    assert.deepEqual(rejectedNested.rejectedPublicFields, ['cascadedLlmModels.qwen'])
    assert.equal(controller.getDraft(nestedDraft), tooLong)
    assert.equal(statuses.at(-1), '部分设置未保存')

    controller.setDraft(nestedDraft, 'qwen-retry')
    controller.applyLocal({cascadedLlmModels: {qwen: 'qwen-retry'}})
    const acceptedNested = await controller.push({
      cascadedLlmModels: {qwen: 'qwen-retry'},
    }, '已保存')
    assert.equal(acceptedNested.saved, true)
    assert.deepEqual(acceptedNested.rejectedPublicFields, [])
    assert.equal(controller.clearDraftIfEqual(nestedDraft, 'qwen-retry'), true)
    assert.equal(controller.getDraft(nestedDraft), undefined)
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
  assert.match(css, /#E8ECF2/i)
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
  assert.match(script, /llmDraftKey\(view\.cascadedLlmProvider\)/)
  assert.match(script, /cascadedLlmModels: \{ \[provider\]: value \}/)
  assert.match(controllerScript, /merged\[field\] = bothObjects \? \{ \.\.\.existing, \.\.\.value \} : value/)
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
  assert.match(html, /运行配置保存后，后台会自动重启并重新连接/)
  assert.match(html, /配色更改立即生效/)
  assert.match(html, /<p id="keyring-warning"[^>]*hidden[^>]*>密钥将以明文保存\(系统未提供钥匙串\)<\/p>/)
})

test('the panel exposes packaged Codex, Projects, and model endpoint configuration', () => {
  for (const id of [
    'codex-status',
    'codexBinaryPath',
    'codex-rescan',
    'codexProjectsEnabled',
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
  assert.match(script, /codexProjectsEnabled:\s*codexProjectsEnabled\.checked/)
  assert.match(script, /saveText\('codexWorkspace', codexWorkspace\)/)
  assert.match(script, /saveText\('codexManagedRoot', codexManagedRoot\)/)
  assert.match(script, /saveText\('modelBaseUrl', modelBaseUrl\)/)
})

test('the panel exposes backend state and opt-in microphone activation', () => {
  assert.match(html, /id="backend-status"/)
  assert.match(html, /id="startListeningOnLaunch"/)
  assert.match(html, /启动时自动开始监听/)
  assert.match(script, /backendStatus\.textContent/)
  assert.match(script, /startListeningOnLaunch\.checked = view\.startListeningOnLaunch === true/)
  assert.match(script, /startListeningOnLaunch:\s*startListeningOnLaunch\.checked/)
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
  assert.doesNotMatch(script, /\.secrets\b|\.data\b|decrypt/)
  assert.doesNotMatch(controllerScript, /\.secrets\b|ciphertext|decrypt/)
})

test('the keyring warning is driven by the flag main reports', () => {
  // Shown only when main explicitly says the keyring is unavailable: a missing
  // flag is not evidence of plaintext storage, so it must not raise the alarm.
  assert.match(script, /warning\.hidden = view\.keyringAvailable !== false/)
})

test('palette changes push immediately while key edits wait for their button', () => {
  assert.match(script, /addEventListener\('change'/)
  assert.match(script, /input\[name="palette"\]/)
  assert.match(script, /push\(\{ palette: input\.value \}/)
  assert.match(script, /saveSecrets/)
  assert.match(script, /button\.clear/)
})

test('a change made mid-save is coalesced and flushed, never dropped', () => {
  // The old behaviour refused the second change outright, which silently lost
  // it: a slider nudged twice in a second kept only the first value. Now the
  // newest patch per field waits in `pendingPatch` and is pushed as soon as the
  // in-flight save resolves.
  assert.match(script, /createSettingsController/)
  assert.match(controllerScript, /let inFlight = null/)
  assert.match(controllerScript, /let pending = null/)
  assert.match(controllerScript, /pending\.patch = mergePatch\(pending\.patch, writePatch\(patch\)\)/)
  // The flush happens after the save settles, and the merge goes one level
  // deeper wherever a field carries an object, so two key edits queued behind
  // the same save cannot erase each other.
  assert.match(controllerScript, /resolveBatch\(batch, bridgeSaved, remoteView\)/)
  assert.match(controllerScript, /void flush\(\)/)
  assert.match(controllerScript, /function mergePatch\(base, next\)/)
})

test('saveSecrets clears only the fields the save actually accepted', () => {
  // Old behaviour: any successful save cleared every key field, including one
  // the store had just refused (a control character, say) — the user's paste
  // vanished from the screen with 密钥已保存 showing and no other signal but
  // the 未设置 badge. Now a field is cleared only if it is not in the rejected
  // set the response names.
  assert.match(script, /const result = await controller\.saveSecrets\(secrets\)/)
  assert.match(script, /for \(const key of result\.accepted\) \{/)
  assert.match(script, /if \(secretRevisions\.matches\(key, input\.value, submissions\[key\]\)\) input\.value = ''/)
  assert.match(controllerScript, /return \{ \.\.\.result, rejected, accepted \}/)
})

test('saveSecrets names any rejected key by its panel label and only reports success when nothing was rejected', () => {
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
  assert.match(script, /if \(result\.rejected\.length\) \{/)
  assert.match(
    script,
    /statusLabel\.textContent = `部分密钥未保存\(含非法字符\): \$\{labels\.join\('、'\)\}`/,
  )
  assert.match(
    script,
    /const labels = result\.rejected\.map\(key => SECRET_LABELS\[key\]\)/,
  )
})
