export interface Clock {
  now(): number
  sleep(duration: number, signal?: AbortSignal): Promise<void>
}

interface Waiter {
  readonly due: number
  readonly sequence: number
  readonly resolve: () => void
  readonly reject: (reason: Error) => void
  readonly signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  settled: boolean
}

export class VirtualClock implements Clock {
  readonly #waiters: Waiter[] = []
  #current: number
  #sequence = 0

  constructor(start = 0) {
    requireFiniteOrInfinity(start, 'virtual clock start')
    this.#current = start
  }

  now(): number {
    return this.#current
  }

  sleep(duration: number, signal?: AbortSignal): Promise<void> {
    requireFiniteOrInfinity(duration, 'sleep duration')
    if (duration < 0) throw new RangeError(`sleep duration cannot be negative: ${duration}`)
    if (signal?.aborted === true) return Promise.reject(abortError())

    return new Promise((resolve, reject) => {
      this.#sequence += 1
      const waiter: Waiter = {
        due: this.#current + duration,
        sequence: this.#sequence,
        resolve,
        reject,
        signal,
        onAbort: undefined,
        settled: false,
      }
      waiter.onAbort = () => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.reject(abortError())
        this.#discardSettled()
      }
      signal?.addEventListener('abort', waiter.onAbort, {once: true})
      this.#waiters.push(waiter)
      this.#waiters.sort(compareWaiters)
    })
  }

  waiterCount(): number {
    return this.#waiters.reduce((count, waiter) => count + Number(!waiter.settled), 0)
  }

  nextTimerTimestamp(): number | undefined {
    const waiter = this.#waiters.find(candidate => !candidate.settled)
    return waiter === undefined || !Number.isFinite(waiter.due) ? undefined : waiter.due
  }

  advanceTo(timestamp: number): void {
    requireFiniteOrInfinity(timestamp, 'virtual clock timestamp')
    if (timestamp < this.#current) {
      throw new RangeError(`virtual clock cannot move backwards: ${this.#current} -> ${timestamp}`)
    }
    this.#current = timestamp

    for (const waiter of this.#waiters) {
      if (waiter.settled || waiter.due > timestamp) continue
      waiter.settled = true
      if (waiter.onAbort !== undefined) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
      }
      waiter.resolve()
    }
    this.#discardSettled()
  }

  #discardSettled(): void {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      if (this.#waiters[index]?.settled === true) this.#waiters.splice(index, 1)
    }
  }
}

export class RealClock implements Clock {
  now(): number {
    return performance.now() / 1000
  }

  async sleep(duration: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new RangeError(`sleep duration must be a non-negative finite number: ${duration}`)
    }
    if (signal?.aborted === true) throw abortError()
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError())
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, duration * 1000)
      signal?.addEventListener('abort', onAbort, {once: true})
    })
  }
}

function compareWaiters(left: Waiter, right: Waiter): number {
  return left.due - right.due || left.sequence - right.sequence
}

function requireFiniteOrInfinity(value: number, field: string): void {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`${field} cannot be NaN`)
  }
}

function abortError(): Error {
  const error = new Error('sleep aborted')
  error.name = 'AbortError'
  return error
}
