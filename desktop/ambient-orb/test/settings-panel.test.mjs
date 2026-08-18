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

test('the heartbeat slider and voice field carry their labelled bounds', () => {
  assert.match(html, /Codex 播报间隔/)
  assert.match(html, /<input type="range" id="heartbeat" min="15" max="120" step="1"/)
  assert.match(html, /语音音色/)
  assert.match(html, /<input type="text" id="voice" maxlength="64"/)
})

test('every API key is a password field with a badge, hint, and clear button', () => {
  for (const key of ['dashscopeApiKey', 'tavilyApiKey', 'modelApiKey', 'codexApiKey']) {
    assert.match(html, new RegExp(`<input type="password" id="${key}"[^>]*placeholder="留空保持不变"`))
    assert.match(html, new RegExp(`<span class="badge" id="badge-${key}">未设置</span>`))
    assert.match(html, new RegExp(`<button type="button" class="clear" data-key="${key}">清除</button>`))
  }
  assert.match(html, /DashScope/)
  assert.match(html, /Tavily/)
  assert.match(html, /模型网关/)
  assert.match(html, /Codex/)
  assert.equal((html.match(/type="password"/g) || []).length, 4)
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
  // An impatient second change mid-save is refused, and the panel re-renders
  // from the last stored answer rather than leaving an unsaved value on screen.
  assert.match(script, /let saving = false/)
  assert.match(script, /if \(saving\) \{\n\s*render\(latestView\)/)
})
