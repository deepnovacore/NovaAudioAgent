export class ConfirmationCountdown {
  #now
  #schedule
  #cancel
  #onTick
  #deadline = null
  #timer = null

  constructor({
    now = () => performance.now(),
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = timer => clearTimeout(timer),
    onTick,
  }) {
    if (typeof now !== 'function' || typeof schedule !== 'function'
      || typeof cancel !== 'function' || typeof onTick !== 'function') {
      throw new TypeError('invalid confirmation countdown port')
    }
    this.#now = now
    this.#schedule = schedule
    this.#cancel = cancel
    this.#onTick = onTick
  }

  /** Start from a relative runtime snapshot; never compare the runtime clock to the wall clock. */
  start(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError('invalid confirmation countdown duration')
    }
    this.stop()
    this.#deadline = this.#now() + (seconds * 1_000)
    this.#scheduleNext()
  }

  stop() {
    if (this.#timer !== null) this.#cancel(this.#timer)
    this.#timer = null
    this.#deadline = null
  }

  #scheduleNext() {
    if (this.#deadline === null) return
    const remaining = Math.max(0, (this.#deadline - this.#now()) / 1_000)
    if (remaining === 0) return
    const fractional = remaining - Math.floor(remaining)
    const delay = Math.max(1, (fractional > 1e-6 ? fractional : 1) * 1_000)
    this.#timer = this.#schedule(() => {
      this.#timer = null
      if (this.#deadline === null) return
      const next = Math.max(0, (this.#deadline - this.#now()) / 1_000)
      this.#onTick(next)
      if (next === 0) {
        this.#deadline = null
        return
      }
      this.#scheduleNext()
    }, delay)
  }
}
