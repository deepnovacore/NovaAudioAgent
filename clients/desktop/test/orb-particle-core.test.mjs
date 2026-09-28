import test from 'node:test'
import assert from 'node:assert/strict'
import { createParticleCoreVisual } from '../src/renderer/orb-particle-core.mjs'

function fixture(options = {}) {
  const listeners = new Map(),
    pending = new Map()
  let seq = 0,
    reads = 0
  const colors = []
  const query = { addEventListener() {}, removeEventListener() {} }
  const win = {
    devicePixelRatio: 2,
    matchMedia: () => query,
    setTimeout(fn) {
      const id = ++seq
      pending.set(id, fn)
      return id
    },
    clearTimeout: (id) => pending.delete(id),
    requestAnimationFrame(fn) {
      const id = ++seq
      pending.set(id, fn)
      return id
    },
    cancelAnimationFrame: (id) => pending.delete(id)
  }
  const doc = {
    defaultView: win,
    hidden: false,
    addEventListener: (n, fn) => listeners.set(n, fn),
    removeEventListener: (n) => listeners.delete(n)
  }
  const ctx = new Proxy(
    { createRadialGradient: () => ({ addColorStop() {} }) },
    {
      get(o, k) {
        return k in o ? o[k] : () => {}
      },
      set(o, k, v) {
        o[k] = v
        if (k === 'fillStyle') colors.push(v)
        return true
      }
    }
  )
  const canvas = { ownerDocument: doc, getContext: () => ctx }
  const visual = createParticleCoreVisual(canvas, {
    skin: {
      color: '#5cddff',
      accent: '#dcc399',
      particleCount: 480,
      rotationSpeed: 0.17
    },
    getSpeakingLevel() {
      reads++
      return 0.8
    },
    ...options
  })
  return {
    visual,
    canvas,
    doc,
    pending,
    listeners,
    colors,
    get reads() {
      return reads
    }
  }
}
test('real playback callback only used while speaking; input levels stay bounded', () => {
  const f = fixture()
  f.visual.setState('idle')
  assert.equal(f.reads, 0)
  f.visual.setLevel(5)
  assert.equal(f.visual.level, 1)
  f.visual.setState('listening')
  assert.ok(f.visual.smoothedLevel > 0)
  assert.equal(f.reads, 0)
  f.visual.setState('speaking')
  assert.ok(f.reads > 0)
  f.visual.setLevel(NaN)
  assert.equal(f.visual.level, 0)
  f.visual.destroy()
})
test('error and mute remain distinct states, Retina size is retained', () => {
  const f = fixture()
  assert.equal(f.canvas.width, 232)
  f.visual.setState('authentication-failed')
  assert.equal(f.visual.state, 'authentication-failed')
  assert.ok(f.colors.includes('#ff9d88'))
  f.visual.setState('muted')
  assert.equal(f.visual.state, 'muted')
  f.visual.destroy()
})
test('hidden and destroyed surfaces cancel animation work', () => {
  const f = fixture()
  assert.ok(f.pending.size > 0)
  f.doc.hidden = true
  f.listeners.get('visibilitychange')()
  assert.equal(f.pending.size, 0)
  f.doc.hidden = false
  f.listeners.get('visibilitychange')()
  assert.ok(f.pending.size > 0)
  f.visual.destroy()
  assert.equal(f.pending.size, 0)
  assert.equal(f.listeners.size, 0)
  f.visual.setState('speaking')
  assert.equal(f.pending.size, 0)
})
test('reduced motion draws once without starting an animation loop', () => {
  const f = fixture({ reducedMotion: true })
  assert.equal(f.visual.fps, 0)
  assert.equal(f.pending.size, 0)
  f.visual.setState('speaking')
  assert.equal(f.pending.size, 0)
  f.visual.destroy()
})
