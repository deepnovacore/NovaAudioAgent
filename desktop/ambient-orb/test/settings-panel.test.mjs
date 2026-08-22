import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../src/renderer/settings.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../src/renderer/settings.mjs', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/renderer/settings.css', import.meta.url), 'utf8')

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

test('the heartbeat slider and integrated Qwen fields carry their labelled bounds', () => {
  assert.match(html, /Codex 播报间隔/)
  assert.match(html, /<input type="range" id="heartbeat" min="15" max="120" step="1"/)
  assert.match(html, /Qwen 实时模型/)
  assert.match(html, /<input type="text" id="integratedModel" maxlength="128"/)
  assert.match(html, /Qwen 语音音色/)
  assert.match(html, /<input type="text" id="integratedVoice" maxlength="128"/)
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
    'cascadedTtsVoice',
  ]) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(script, /integratedSection\.hidden = view\.pipelineMode !== 'integrated'/)
  assert.match(script, /cascadedSection\.hidden = view\.pipelineMode !== 'cascaded'/)
})

test('the active cascaded model follows its provider and preserves the other model', () => {
  assert.match(script, /cascadedLlmModel\.value = view\.cascadedLlmModels\?\.\[view\.cascadedLlmProvider\] \?\? ''/)
  assert.match(script, /cascadedLlmModels: \{ \[cascadedLlmProvider\.value\]: cascadedLlmModel\.value \}/)
  assert.match(script, /mergePatch\(pendingPatch, patch\)/)
})

test('key usage labels are derived from public pipeline selection only', () => {
  assert.match(script, /function keyUsage\(view\)/)
  assert.match(script, /dashscopeApiKey: view\.pipelineMode === 'integrated'/)
  assert.match(script, /arkApiKey: view\.pipelineMode === 'cascaded'/)
  assert.match(script, /doubaoBigmodelApiKey: view\.pipelineMode === 'cascaded'/)
  assert.match(script, /doubaoAsrApiKey: view\.pipelineMode === 'cascaded'/)
  assert.doesNotMatch(script, /\.secrets\b|ciphertext|decrypt/)
})

test('the panel states what applies now and what waits for the next launch', () => {
  assert.match(html, /语音、主动性与 API 密钥设置将在下次启动生效/)
  assert.match(html, /配色更改立即生效/)
  assert.match(html, /<p id="keyring-warning"[^>]*hidden[^>]*>密钥将以明文保存\(系统未提供钥匙串\)<\/p>/)
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
  assert.match(script, /input\.value = ''/)
  assert.doesNotMatch(script, /\.secrets\b|\.data\b|decrypt/)
  const passwordWrites = [...script.matchAll(/input\.value = ([^\n]+)/g)].map(match => match[1])
  assert.ok(passwordWrites.length > 0)
  for (const written of passwordWrites) {
    assert.equal(written, "''", 'the only write into a password field clears it')
  }
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
  assert.match(script, /let saving = false/)
  assert.match(script, /let pendingPatch = null/)
  assert.match(script, /if \(saving\) \{\n\s*pendingPatch = mergePatch\(pendingPatch, patch\)/)
  assert.doesNotMatch(script, /if \(saving\) \{\n\s*render\(/)
  // The flush happens after the save settles, and the merge goes one level
  // deeper wherever a field carries an object, so two key edits queued behind
  // the same save cannot erase each other.
  assert.match(script, /if \(pendingPatch\)/)
  assert.match(script, /void push\(nextPatch, nextNote\)/)
  assert.match(script, /function mergePatch\(base, next\)/)
  assert.match(script, /merged\[field\] = bothObjects \? \{ \.\.\.existing, \.\.\.value \} : value/)
})

test('saveSecrets clears only the fields the save actually accepted', () => {
  // Old behaviour: any successful save cleared every key field, including one
  // the store had just refused (a control character, say) — the user's paste
  // vanished from the screen with 密钥已保存 showing and no other signal but
  // the 未设置 badge. Now a field is cleared only if it is not in the rejected
  // set the response names.
  assert.match(script, /const \{ saved, view \} = await push\(\{ secrets \}, '密钥已保存'\)/)
  assert.match(script, /const rejected = new Set\(view\?\.rejectedSecrets \?\? \[\]\)/)
  assert.match(script, /for \(const key of Object\.keys\(secrets\)\) \{/)
  assert.match(script, /if \(!rejected\.has\(key\)\) input\.value = ''/)
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
  // The error line is gated on `rejected.size`, so an all-accepted save keeps
  // the plain 密钥已保存 note `push` already set and never reaches this branch.
  assert.match(script, /if \(rejected\.size\) \{/)
  assert.match(
    script,
    /statusLabel\.textContent = `部分密钥未保存\(含非法字符\): \$\{labels\.join\('、'\)\}`/,
  )
  assert.match(
    script,
    /const labels = SECRET_KEYS\.filter\(key => rejected\.has\(key\)\)\.map\(key => SECRET_LABELS\[key\]\)/,
  )
})
