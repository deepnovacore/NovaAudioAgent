export const HOVER_DELAY_MS = 3000
export const PALETTE_TRANSITION_MS = 6000
export const PALETTE_HOLD_MS = 4000

export const AUTO_PALETTE_SEQUENCE = Object.freeze([
  'ember',
  'halpha',
  'ion',
  'violet',
  'graphite',
])

export class OrbPaletteHoverController {
  constructor({
    initialPalette = 'ember',
    transition,
    setPalette,
    setTextPalette,
    schedule = globalThis.setTimeout,
    cancel = globalThis.clearTimeout,
    sequence = AUTO_PALETTE_SEQUENCE,
    disabled = false,
  }) {
    this.transition = transition
    this.setPalette = setPalette
    this.setTextPalette = setTextPalette
    // Browser timer functions are host methods, not receiver-agnostic helpers:
    // storing one on this controller and calling `this.schedule()` would bind
    // the controller as `this` and Chromium rejects that as an illegal
    // invocation. Bind both timer edges to their owning global once.
    this.schedule = schedule.bind(globalThis)
    this.cancel = cancel.bind(globalThis)
    this.sequence = sequence
    this.current = sequence.includes(initialPalette) ? initialPalette : 'ember'
    this.disabled = disabled
    this.hovering = false
    this.transitioning = false
    this.timer = null
    this.generation = 0
    this.destroyed = false
  }

  enter() {
    if (this.destroyed || this.hovering) return
    this.hovering = true
    this.armDwell()
  }

  leave() {
    if (this.destroyed || !this.hovering) return
    this.hovering = false
    this.clearTimer()
  }

  reset(palette) {
    if (this.destroyed) return
    this.generation += 1
    this.transitioning = false
    this.clearTimer()
    this.current = this.sequence.includes(palette) ? palette : 'ember'
    this.setPalette?.(this.current)
    this.setTextPalette?.(this.current, 0)
    this.armDwell()
  }

  setDisabled(disabled) {
    if (this.destroyed || this.disabled === Boolean(disabled)) return
    this.disabled = Boolean(disabled)
    this.generation += 1
    this.transitioning = false
    this.clearTimer()
    if (this.disabled) {
      this.setPalette?.(this.current)
      this.setTextPalette?.(this.current, 0)
    }
    if (!this.disabled) this.armDwell()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.generation += 1
    this.clearTimer()
  }

  armDwell() {
    if (this.destroyed || this.disabled || !this.hovering || this.transitioning || this.timer !== null) return
    this.timer = this.schedule(() => {
      this.timer = null
      this.beginNext()
    }, HOVER_DELAY_MS)
  }

  beginNext() {
    if (this.destroyed || this.disabled || !this.hovering || this.transitioning) return
    const currentIndex = this.sequence.indexOf(this.current)
    const target = this.sequence[(currentIndex + 1) % this.sequence.length]
    const generation = ++this.generation
    this.transitioning = true
    this.setTextPalette?.(target, PALETTE_TRANSITION_MS)
    this.transition?.(target, {
      durationMs: PALETTE_TRANSITION_MS,
      onComplete: () => {
        if (this.destroyed || generation !== this.generation) return
        this.current = target
        this.transitioning = false
        if (!this.hovering || this.disabled) return
        this.timer = this.schedule(() => {
          this.timer = null
          this.beginNext()
        }, PALETTE_HOLD_MS)
      },
    })
  }

  clearTimer() {
    if (this.timer === null) return
    this.cancel(this.timer)
    this.timer = null
  }
}
