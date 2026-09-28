// Trusted renderer for declarative particle-core skins. Audio levels come only from Nova.
const SIZE = 116,
  CENTER = 58,
  TAU = Math.PI * 2
const WARN = new Set([
  'permission-denied',
  'microphone-restricted',
  'microphone-no-device',
  'microphone-busy',
  'microphone-unavailable',
  'audio-pipeline-error',
  'configuration-required',
  'authentication-failed',
  'backend-unavailable',
  'error'
])
const DIM = new Set(['inactive', 'muted', 'disconnected'])
const PENDING = new Set(['booting', 'reconnecting', 'candidate'])

export function createParticleCoreVisual(canvas, options = {}) {
  const skin = options.skin
  const color = skin.color
    .slice(1)
    .match(/../g)
    .map((value) => parseInt(value, 16))
    .join(',')
  const ctx = canvas?.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  const doc = canvas.ownerDocument,
    win = doc.defaultView
  let state = 'booting',
    level = 0,
    smooth = 0,
    palette = options.palette ?? 'ember'
  let working = false,
    destroyed = false,
    frame = null,
    timer = null,
    time = 0,
    last = null
  let reduced = options.reducedMotion === true,
    contrast = options.highContrast === true,
    burst = 0,
    ratio = 0
  const particles = Array.from({ length: skin.particleCount }, (_, i) => {
    const y = 1 - (i / (skin.particleCount - 1)) * 2,
      r = Math.sqrt(1 - y * y),
      a = i * Math.PI * (3 - Math.sqrt(5))
    return { x: Math.cos(a) * r, y, z: Math.sin(a) * r }
  })
  const positioned = particles.map(() => ({ x: 0, y: 0, z: 0 }))
  function fit() {
    const r = Math.max(1, Math.min(2, win.devicePixelRatio || 1))
    if (r === ratio) return
    ratio = r
    canvas.width = SIZE * r
    canvas.height = SIZE * r
    ctx.setTransform(r, 0, 0, r, 0, 0)
  }
  function stop() {
    if (frame !== null) win.cancelAnimationFrame(frame)
    if (timer !== null) win.clearTimeout(timer)
    frame = timer = null
  }
  function schedule() {
    if (
      destroyed ||
      doc.hidden ||
      options.staticPreview ||
      reduced ||
      contrast ||
      frame !== null ||
      timer !== null
    )
      return
    timer = win.setTimeout(
      () => {
        timer = null
        frame = win.requestAnimationFrame(tick)
      },
      state === 'idle' ? 65 : DIM.has(state) ? 180 : 30
    )
  }
  function tick(now) {
    frame = null
    if (destroyed || doc.hidden) return
    const dt = last === null ? 16 : Math.min(100, Math.max(0, now - last))
    last = now
    time += dt * 0.001
    try {
      draw(dt)
      schedule()
    } catch (error) {
      stop()
      options.onError?.(error)
    }
  }
  function arc(radius, start, end, color, width = 0.65) {
    ctx.beginPath()
    ctx.arc(CENTER, CENTER, radius, start, end)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  function draw(dt = 16) {
    fit()
    const warning = WARN.has(state),
      dim = DIM.has(state),
      active = state === 'speaking' || state === 'listening'
    let input = state === 'listening' ? level : 0
    if (
      state === 'speaking' &&
      typeof options.getSpeakingLevel === 'function'
    ) {
      try {
        const value = Number(options.getSpeakingLevel())
        input = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
      } catch {
        input = 0
      }
    }
    const tau = input > smooth ? (state === 'listening' ? 140 : 40) : 400
    smooth += (input - smooth) * (1 - Math.exp(-dt / tau))
    burst *= 0.88
    const t = reduced || contrast ? 0 : time,
      rgb = warning ? '255,125,108' : color
    const opacity = dim ? 0.4 : 1,
      r = 31 + (state === 'listening' ? -1 : 1) * smooth * 5 + burst
    const tint = (a) => `rgba(${rgb},${a * opacity})`
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.arc(CENTER, CENTER, 57, 0, TAU)
    ctx.clip()
    const ground = ctx.createRadialGradient(49, 44, 1, CENTER, CENTER, 57)
    ground.addColorStop(0, '#102e3d')
    ground.addColorStop(0.6, '#07131e')
    ground.addColorStop(1, '#03070c')
    ctx.fillStyle = ground
    ctx.fillRect(0, 0, SIZE, SIZE)
    arc(56, 0, TAU, tint(0.35), 0.7)
    arc(50.5, 0, TAU, tint(0.17), 0.5)
    const speed = active ? 0.16 : PENDING.has(state) ? 0.28 : 0.065
    for (let i = 0; i < 100; i++) {
      const a = (i / 100) * TAU + t * speed,
        outer = i % 5 === 0 ? 55.5 : 54.5,
        inner = i % 5 === 0 ? 52.5 : 53.5
      ctx.beginPath()
      ctx.moveTo(CENTER + Math.cos(a) * inner, CENTER + Math.sin(a) * inner)
      ctx.lineTo(CENTER + Math.cos(a) * outer, CENTER + Math.sin(a) * outer)
      ctx.strokeStyle = tint(i % 5 === 0 ? 0.7 : 0.27)
      ctx.lineWidth = 0.55
      ctx.stroke()
    }
    for (let i = 0; i < 3; i++) {
      const start = (i / 3) * TAU - t * 0.12
      arc(48, start, start + 0.94, tint(0.75), 1.1)
      arc(43, start + 0.5 + t * 0.2, start + 1.3 + t * 0.2, tint(0.2), 0.55)
    }
    arc(
      49,
      t * 0.09 + 0.2,
      t * 0.09 + 0.58,
      warning ? '#ff8373' : skin.accent,
      1
    )
    arc(
      49,
      t * 0.09 + Math.PI + 0.2,
      t * 0.09 + Math.PI + 0.58,
      warning ? '#ff8373' : skin.accent,
      1
    )
    if (working) {
      arc(56.5, t * 0.8, t * 0.8 + 0.55, skin.accent, 1.8)
      arc(56.5, t * 0.8 + Math.PI, t * 0.8 + Math.PI + 0.55, skin.accent, 1.8)
    }
    const glow = ctx.createRadialGradient(CENTER, CENTER, 0, CENTER, CENTER, 44)
    glow.addColorStop(0, tint(0.1 + smooth * 0.11))
    glow.addColorStop(1, tint(0))
    ctx.fillStyle = glow
    ctx.fillRect(8, 8, 100, 100)
    const rot = t * skin.rotationSpeed,
      cr = Math.cos(rot),
      sr = Math.sin(rot)
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i],
        q = positioned[i],
        x = p.x * cr + p.z * sr,
        z = p.z * cr - p.x * sr,
        y = p.y * 0.98 - z * 0.2,
        depth = z * 0.98 + p.y * 0.2
      const w = 1 + Math.sin(p.y * 9 + t + p.x * 4) * (0.025 + smooth * 0.035),
        perspective = 1 + depth * 0.13
      q.x = CENTER + x * r * w * perspective
      q.y = CENTER + y * r * w * perspective
      q.z = depth
    }
    ctx.globalCompositeOperation = 'lighter'
    for (const p of positioned) {
      const front = (p.z + 1) / 2
      ctx.fillStyle = tint(0.12 + front * 0.67)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 0.2 + front * 0.37 + smooth * 0.14, 0, TAU)
      ctx.fill()
    }
    for (let j = 0; j < 4; j++) {
      ctx.beginPath()
      for (let i = 0; i <= 90; i++) {
        const a = (i / 90) * TAU,
          x = CENTER + Math.cos(a) * r * 0.96,
          y =
            CENTER +
            Math.sin(a) * r * 0.22 +
            Math.cos(a * 2 + t * 0.4 + j) * r * 0.06 +
            Math.sin(j + t * 0.3) * r * 0.3
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      ctx.strokeStyle = tint(0.12 + smooth * 0.12)
      ctx.lineWidth = 0.5
      ctx.stroke()
    }
    const highlight = ctx.createRadialGradient(42, 42, 0, 42, 42, 14)
    highlight.addColorStop(0, tint(0.25))
    highlight.addColorStop(1, tint(0))
    ctx.fillStyle = highlight
    ctx.fillRect(22, 22, 40, 40)
    ctx.globalCompositeOperation = 'source-over'
    if (warning) {
      ctx.fillStyle = '#ff9d88'
      ctx.font = '600 12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('!', CENTER, 62)
    }
    if (state === 'muted') {
      ctx.strokeStyle = tint(0.9)
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.moveTo(51, 64)
      ctx.lineTo(65, 50)
      ctx.stroke()
    }
    ctx.restore()
  }
  function refresh() {
    if (destroyed) return
    draw()
    schedule()
  }
  function refreshSafely() {
    try {
      refresh()
    } catch (error) {
      stop()
      options.onError?.(error)
    }
  }
  function onVisibility() {
    stop()
    last = null
    if (!doc.hidden) refreshSafely()
  }
  const reducedQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)'),
    contrastQuery = win.matchMedia?.('(prefers-contrast: more)')
  function onReduced(e) {
    reduced = options.staticPreview || e.matches
    stop()
    refreshSafely()
  }
  function onContrast(e) {
    contrast = e.matches
    stop()
    refreshSafely()
  }
  doc.addEventListener('visibilitychange', onVisibility)
  reducedQuery?.addEventListener('change', onReduced)
  contrastQuery?.addEventListener('change', onContrast)
  try {
    refresh()
  } catch (error) {
    doc.removeEventListener('visibilitychange', onVisibility)
    reducedQuery?.removeEventListener('change', onReduced)
    contrastQuery?.removeEventListener('change', onContrast)
    stop()
    throw error
  }
  return {
    setState(name, { codexWorking = false } = {}) {
      if (destroyed) return
      state = name
      working = codexWorking
      refresh()
    },
    setLevel(value) {
      if (destroyed) return
      const n = Number(value)
      level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
    },
    setPalette(name) {
      if (destroyed) return
      palette = name === 'graphite' ? 'graphite' : 'ember'
      refresh()
    },
    transitionPalette(name, { onComplete } = {}) {
      this.setPalette(name)
      onComplete?.()
    },
    setAccessibility(next) {
      if (destroyed) return
      if (typeof next.reducedMotion === 'boolean') reduced = next.reducedMotion
      if (typeof next.highContrast === 'boolean') contrast = next.highContrast
      stop()
      refresh()
    },
    interrupt() {
      if (destroyed) return
      burst = 1.5
      refresh()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      stop()
      doc.removeEventListener('visibilitychange', onVisibility)
      reducedQuery?.removeEventListener('change', onReduced)
      contrastQuery?.removeEventListener('change', onContrast)
    },
    get state() {
      return state
    },
    get level() {
      return level
    },
    get smoothedLevel() {
      return smooth
    },
    get palette() {
      return palette
    },
    get transitioning() {
      return false
    },
    get particleCount() {
      return skin.particleCount
    },
    get fps() {
      return reduced || contrast || options.staticPreview
        ? 0
        : state === 'idle'
          ? 15
          : DIM.has(state)
            ? 5
            : 30
    }
  }
}
