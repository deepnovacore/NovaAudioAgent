import {t} from './locale.mjs'
import {DEFAULT_SKIN, MAX_SKIN_BYTES, importSkin, removeSkin, selectedSkin} from './orb-skins.mjs'
import {createSkinVisual} from './orb-skin-visual.mjs'

const errorMessage = code => t({
  skin_size: '皮肤文件不能超过 8 KB。',
  skin_duplicate: '此皮肤已存在，请先移除旧版本。',
  skin_limit: '最多保存 16 个导入皮肤。',
  skin_version: '不支持此皮肤版本。',
}[code] ?? '皮肤文件无效或使用了不支持的参数。')

export function createSkinPanel({document, stage, discard, createVisual = createSkinVisual}) {
  const select = document.getElementById('orb-skin')
  const file = document.getElementById('orb-skin-file')
  const remove = document.getElementById('orb-skin-remove')
  const reset = document.getElementById('orb-skin-discard')
  const status = document.getElementById('orb-skin-status')
  // Static preview: no microphone access and no off-screen animation loop.
  const preview = createVisual(document.getElementById('orb-skin-preview'), {reducedMotion: true, staticPreview: true})
  preview.setState('idle')
  let view = {}, busy = false, reading = false, disposed = false
  function controls() {
    reset.disabled = select.disabled = file.disabled = busy || reading
    remove.disabled = busy || reading || selectedSkin(view).id === 'nova'
  }
  const change = () => {
    if (busy || reading) return
    status.textContent = ''
    stage({skinId: select.value})
  }
  const removeSelected = () => {
    if (busy || reading) return
    status.textContent = t('已移除，保存后生效。')
    stage(removeSkin(view, select.value))
  }
  const read = async () => {
    const selected = file.files?.[0]
    if (!selected || busy || reading) return
    reading = true; controls()
    try {
      if (selected.size > MAX_SKIN_BYTES) throw new Error('skin_size')
      const text = await selected.text()
      if (disposed) return
      const patch = importSkin(view, text)
      status.textContent = t('已导入并选中，保存后生效。')
      stage(patch)
    } catch (error) {
      if (!disposed) status.textContent = errorMessage(error.message)
    } finally {
      reading = false
      file.value = ''
      if (!disposed) controls()
    }
  }
  const discardChanges = () => { if (busy || reading) return; status.textContent = ''; discard() }
  reset.addEventListener('click', discardChanges)
  select.addEventListener('change', change)
  remove.addEventListener('click', removeSelected)
  file.addEventListener('change', read)
  return {
    render(next, state = {}) {
      view = next; busy = state.busy === true
      const skins = [DEFAULT_SKIN, ...(view.importedSkins ?? [])]
      select.replaceChildren(...skins.map(skin => {
        const option = document.createElement('option')
        option.value = skin.id
        option.textContent = skin.name
        return option
      }))
      select.value = selectedSkin(view).id
      preview.setSkin(view)
      controls()
    },
    destroy() {
      disposed = true
      preview.destroy()
      reset.removeEventListener('click', discardChanges)
      select.removeEventListener('change', change)
      remove.removeEventListener('click', removeSelected)
      file.removeEventListener('change', read)
    },
  }
}
