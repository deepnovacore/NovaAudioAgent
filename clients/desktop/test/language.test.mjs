import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {preferredLanguage, setLanguage, t} from '../src/renderer/locale.mjs'
import {loadSettings, normalizeSettings, publicSettings} from '../src/main/settings-store.mjs'
import {ENGLISH_MESSAGES} from '../src/renderer/messages.en.mjs'

test('first launch uses the first system language and persists it across later system changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-language-'))
  try {
    const file = join(dir, 'settings.json')
    assert.equal((await loadSettings(file, ['en-US', 'zh-CN'])).language, 'en')
    assert.equal((await loadSettings(file, ['zh-TW'])).language, 'en')
    await writeFile(file, JSON.stringify({version: 4, palette: 'graphite'}))
    const migrated = await loadSettings(file, ['zh-Hant-TW'])
    assert.equal(migrated.language, 'zh-CN')
    assert.equal(migrated.palette, 'graphite')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).language, 'zh-CN')
    await writeFile(file, '{broken')
    await loadSettings(file, ['en'])
    assert.equal(await readFile(file, 'utf8'), '{broken')
    // initialize:false must never rewrite the file the recovery flow still offers to restore.
    const untouched = JSON.stringify({version: 4, palette: 'graphite'})
    await writeFile(file, untouched)
    assert.equal((await loadSettings(file, ['en-US'], {initialize: false})).language, 'en')
    assert.equal(await readFile(file, 'utf8'), untouched)
    assert.equal(preferredLanguage([]), 'en')
    assert.equal(preferredLanguage(['ja-JP', 'zh-CN']), 'en')
    assert.equal(normalizeSettings({language: 'ar'}, {language: 'en'}).language, 'en')
    assert.equal(publicSettings({language: 'en'}).language, 'en')
  } finally { await rm(dir, {recursive: true, force: true}) }
})

test('UI translations retain placeholders and never reinterpret substituted user content', () => {
  for (const [source, translated] of Object.entries(ENGLISH_MESSAGES)) {
    const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()
    assert.deepEqual(placeholders(translated), placeholders(source), source)
  }
  setLanguage('en')
  assert.equal(t('设置'), 'Settings')
  assert.equal(t('进行中 · {0}', '$& {0} 中文项目'), 'In progress · $& {0} 中文项目')
  setLanguage('zh-CN')
  assert.equal(t('设置'), '设置')
})

test('English IM section translates its developer-owned HTML heading and instructions', async context => {
  const html = await readFile(new URL('../src/renderer/settings.html', import.meta.url), 'utf8')
  const section = html.match(/<section[^>]*id="im-section"[^>]*>(.*?)<\/section>/s)?.[1]
  assert.ok(section)
  const text = [...section.matchAll(/<(?:h2|p)\b[^>]*>([^<]+)<\/(?:h2|p)>/g)].map(match => match[1])
  assert.ok(text.length >= 2)
  setLanguage('en'); context.after(() => setLanguage('zh-CN'))
  for (const source of text) assert.doesNotMatch(t(source), /\p{Script=Han}/u, source)
})
