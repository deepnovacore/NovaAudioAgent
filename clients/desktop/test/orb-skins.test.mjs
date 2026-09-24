import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile, mkdtemp, rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseSkin, importSkin, removeSkin, normalizeSkinSettings, selectedSkin, MAX_SKIN_BYTES} from '../src/renderer/orb-skins.mjs'
import {DEFAULT_SETTINGS, normalizeSettings, publicSettings, orbSettings, backendSettings, saveSettings, loadSettings, createSettingsWriter} from '../src/main/settings-store.mjs'
import {validatePreparedSettings} from '../src/main/capabilities-settings.mjs'
import {createSettingsController} from '../src/renderer/settings-controller.mjs'
import {createSkinVisual} from '../src/renderer/orb-skin-visual.mjs'
import {buildRendererAssetGraph} from '../src/main/app-protocol.mjs'

const text = await readFile(new URL('../../../skins/jarvis.nova-skin.json', import.meta.url), 'utf8')
const skin = parseSkin(text)
const imported = importSkin(DEFAULT_SETTINGS, text)

test('packaged renderer graph includes the data contract and trusted renderer', async () => {
  const graph = await buildRendererAssetGraph(fileURLToPath(new URL('../src/renderer', import.meta.url)))
  assert.ok(graph.includes('/orb-skins.mjs'))
  assert.ok(graph.includes('/orb-particle-core.mjs'))
})

test('old settings retain Nova; missing and damaged skins recover to Nova', () => {
  assert.equal(normalizeSettings({palette: 'graphite'}).skinId, 'nova')
  assert.equal(selectedSkin({skinId: 'missing', importedSkins: [skin]}).id, 'nova')
  assert.deepEqual(normalizeSkinSettings({skinId: skin.id, importedSkins: [{...skin, renderer: 'script'}]}), {skinId: 'nova', importedSkins: []})
})

test('import rejects executable content, unsupported versions, paths and excessive work', () => {
  for (const patch of [{script: 'alert(1)'}, {color: 'url(file:///tmp/x)'}, {version: 2}, {renderer: '../custom.js'}, {id: '../x'}, {id: 'nova'}, {particleCount: 601}, {rotationSpeed: Infinity}, {name: ''}]) {
    assert.throws(() => parseSkin(JSON.stringify({...skin, ...patch})))
  }
  assert.throws(() => parseSkin(' '.repeat(MAX_SKIN_BYTES + 1)))
  assert.throws(() => parseSkin('{'))
  assert.throws(() => importSkin(imported, text), /skin_duplicate/)
  const full = {...imported, importedSkins: Array.from({length: 16}, (_, i) => ({...skin, id: `skin-${i}`}))}
  assert.throws(() => importSkin(full, text), /skin_limit/)
})

test('selection/removal reach both public views but never change backend configuration', () => {
  const next = normalizeSettings(imported, DEFAULT_SETTINGS)
  assert.equal(publicSettings(next).skinId, 'jarvis')
  assert.equal(orbSettings(next).importedSkins.length, 1)
  assert.deepEqual(backendSettings(next), backendSettings(DEFAULT_SETTINGS))
  assert.deepEqual(removeSkin(next, 'jarvis'), {skinId: 'nova', importedSkins: []})
})

test('Main validates forged commits, and writer failure preserves the current skin', async () => {
  for (const patch of [{skinId: 'missing'}, {importedSkins: [{...skin, script: 'bad'}]}, {importedSkins: [skin, skin]}]) {
    assert.throws(() => validatePreparedSettings(patch, publicSettings(normalizeSettings(patch))))
  }
  validatePreparedSettings(imported, publicSettings(normalizeSettings(imported)))
  let current = DEFAULT_SETTINGS
  const writer = createSettingsWriter({getCurrent: () => current, codec: {available: () => false}, commit: next => {current = next}, save: async () => {throw new Error('disk full')}})
  await assert.rejects(writer(imported), /disk full/)
  assert.equal(current.skinId, 'nova')
})

test('saved library survives restart without referencing the source file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-skin-test-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const file = join(dir, 'settings.json')
  await saveSettings(file, normalizeSettings(imported))
  assert.deepEqual(normalizeSkinSettings(await loadSettings(file)), imported)
})

test('import is a draft; discard restores it, save commits array replacement including deletion', async () => {
  let confirmed = publicSettings(DEFAULT_SETTINGS)
  const calls = []
  const controller = createSettingsController({api: {set: async patch => {calls.push(patch); confirmed = {...confirmed, ...patch}; return {...confirmed, saved: true}}}, render() {}, status() {}})
  controller.setView(confirmed)
  controller.stage({proactivity: 'eager'})
  controller.stage(imported)
  assert.equal(calls.length, 0)
  assert.equal(controller.snapshot().view.skinId, 'jarvis')
  controller.discardFields(['skinId', 'importedSkins'])
  assert.equal(controller.snapshot().view.proactivity, 'eager', 'discard preserves unrelated drafts')
  assert.equal(controller.snapshot().view.skinId, 'nova')
  controller.stage(imported)
  assert.equal((await controller.save()).saved, true)
  assert.equal(controller.dirty, false)
  controller.stage(removeSkin(controller.snapshot().view, 'jarvis'))
  assert.equal((await controller.save()).saved, true)
  assert.equal(controller.dirty, false)
  assert.deepEqual(calls[1].importedSkins, [])
  assert.equal(confirmed.skinId, 'nova')
})

function visualFixture() {
  const created = []
  function factory(_canvas, options) {
    const v = {options, destroyed: false, setState(name, extra) {this.state = name; this.extra = extra}, setLevel(n) {this.level = n}, setPalette(n) {this.palette = n}, setAccessibility() {}, transitionPalette() {}, interrupt() {}, destroy() {this.destroyed = true}}
    created.push(v)
    return v
  }
  return {created, visual: createSkinVisual({}, {}, {nova: factory, 'particle-core': factory})}
}
test('live switching disposes old loops and preserves voice/Codex state and level', () => {
  const {visual, created} = visualFixture()
  visual.setState('listening', {codexWorking: true}); visual.setLevel(.7)
  visual.setSkin(imported)
  assert.equal(created[0].destroyed, true)
  assert.equal(created[1].state, 'listening'); assert.equal(created[1].level, .7)
  assert.equal(created[1].extra.codexWorking, true)
  visual.setSkin(imported)
  assert.equal(created.length, 2, 'unrelated settings pushes do not recreate animations')
  visual.setSkin({})
  assert.equal(created[1].destroyed, true)
  visual.destroy(); visual.setSkin(imported)
  assert.equal(created.length, 3)
})
test('asynchronous custom draw failure releases resources and falls back to Nova', () => {
  const {visual, created} = visualFixture()
  visual.setSkin(imported); visual.setState('speaking')
  created[1].options.onError(new Error('canvas lost'))
  assert.equal(created[1].destroyed, true)
  assert.equal(created[2].state, 'speaking')
  visual.destroy()
})
