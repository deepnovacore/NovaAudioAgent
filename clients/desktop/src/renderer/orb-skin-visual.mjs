import {createOrbVisualSafe} from './orb-visual.mjs'
import {createParticleCoreVisual} from './orb-particle-core.mjs'
import {selectedSkin} from './orb-skins.mjs'

// Owns exactly one animation lifecycle; voice and DOM interactions keep a stable facade.
export function createSkinVisual(canvas, options = {}, factories = {
  nova: createOrbVisualSafe, 'particle-core': createParticleCoreVisual,
}) {
  let target, signature, destroyed = false, generation = 0
  let state = 'booting', stateOptions = {}, level = 0
  let palette = options.palette ?? 'ember', accessibility = {
    reducedMotion: options.reducedMotion, highContrast: options.highContrast,
  }
  function restore() {
    target.setPalette(palette)
    target.setAccessibility(accessibility)
    target.setLevel(level)
    target.setState(state, stateOptions)
  }
  function fallback() {
    if (destroyed) return
    generation += 1
    try { target?.destroy() } catch { /* Broken decoration must never stop voice. */ }
    target = factories.nova(canvas, {...options, ...accessibility, palette})
    restore()
  }
  function invoke(name, ...args) {
    if (destroyed) return
    try { return target[name](...args) }
    catch { fallback() }
  }
  function setSkin(settings = {}) {
    if (destroyed) return
    const skin = selectedSkin(settings), next = JSON.stringify(skin)
    if (signature === next) return
    signature = next
    const epoch = ++generation
    try { target?.destroy() } catch { /* Continue with a clean visual. */ }
    try {
      target = factories[skin.renderer](canvas, {...options, ...accessibility, palette, skin, onError: () => { if (generation === epoch) fallback() }})
      restore()
    } catch { fallback() }
  }
  setSkin()
  return Object.freeze({
    setSkin,
    setState(name, next = {}) { state = name; stateOptions = next; invoke('setState', name, next) },
    setLevel(value) { level = value; invoke('setLevel', value) },
    setPalette(name) { palette = name; invoke('setPalette', name) },
    transitionPalette(name, next) { palette = name; invoke('transitionPalette', name, next) },
    setAccessibility(next) { accessibility = {...accessibility, ...next}; invoke('setAccessibility', next) },
    interrupt() { invoke('interrupt') },
    destroy() { if (destroyed) return; destroyed = true; target.destroy() },
    get params() { return target.params },
    get state() { return target.state },
    get palette() { return target.palette },
    get transitioning() { return target.transitioning },
    get level() { return target.level },
    get smoothedLevel() { return target.smoothedLevel },
    get fps() { return target.fps },
    get particleCount() { return target.particleCount },
  })
}
