// Data-only skin contract shared by Main and the sandboxed renderer.
export const MAX_SKIN_BYTES = 8192
export const MAX_IMPORTED_SKINS = 16
export const DEFAULT_SKIN = Object.freeze({id: 'nova', name: 'Nova', renderer: 'nova'})
const fields = ['version', 'id', 'name', 'renderer', 'color', 'accent', 'particleCount', 'rotationSpeed']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateSkin(value) {
  if (!record(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('skin_fields')
  if (value.version !== 1) throw new Error('skin_version')
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id) || value.id === 'nova') throw new Error('skin_id')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value.name)) throw new Error('skin_name')
  if (value.renderer !== 'particle-core') throw new Error('skin_renderer')
  for (const key of ['color', 'accent']) if (typeof value[key] !== 'string' || !/^#[\da-fA-F]{6}$/.test(value[key])) throw new Error('skin_color')
  if (!Number.isInteger(value.particleCount) || value.particleCount < 120 || value.particleCount > 600) throw new Error('skin_particles')
  if (!Number.isFinite(value.rotationSpeed) || value.rotationSpeed < 0 || value.rotationSpeed > 1) throw new Error('skin_speed')
  return Object.fromEntries(fields.map(key => [key, value[key]]))
}

export function parseSkin(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_SKIN_BYTES) throw new Error('skin_size')
  return validateSkin(JSON.parse(text))
}

export function validateSkinLibrary(value) {
  if (!Array.isArray(value) || value.length > MAX_IMPORTED_SKINS) throw new Error('skin_limit')
  const skins = value.map(validateSkin)
  if (new Set(skins.map(skin => skin.id)).size !== skins.length) throw new Error('skin_duplicate')
  return skins
}

export function normalizeSkinSettings(source = {}, base = {}) {
  let importedSkins
  try { importedSkins = validateSkinLibrary(source.importedSkins ?? base.importedSkins ?? []) }
  catch { importedSkins = [] }
  const selected = source.skinId ?? base.skinId
  return {importedSkins, skinId: importedSkins.some(skin => skin.id === selected) ? selected : 'nova'}
}

export function selectedSkin(settings) {
  const {importedSkins, skinId} = normalizeSkinSettings(settings)
  return importedSkins.find(skin => skin.id === skinId) ?? DEFAULT_SKIN
}

export function importSkin(settings, text) {
  const skin = parseSkin(text)
  const {importedSkins} = normalizeSkinSettings(settings)
  if (importedSkins.some(item => item.id === skin.id)) throw new Error('skin_duplicate')
  return {skinId: skin.id, importedSkins: validateSkinLibrary([...importedSkins, skin])}
}

export function removeSkin(settings, id) {
  const normalized = normalizeSkinSettings(settings)
  return normalizeSkinSettings({...normalized, importedSkins: normalized.importedSkins.filter(skin => skin.id !== id)})
}
