import type {Clock} from '../core/clock.js'

/** Human decision time is unbounded here; approval controllers own their own expiry policy. */
export function createTurnDeadline(options: {
  readonly clock: Clock
  readonly parent: AbortSignal
  readonly isWaiting: () => boolean
  readonly subscribe: (listener: () => void) => () => void
}): {readonly signal: AbortSignal; readonly close: () => void} {
  const controller = new AbortController()
  let timer: AbortController | undefined
  let unsubscribe: (() => void) | undefined
  let waiting: boolean | undefined
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    timer?.abort()
    unsubscribe?.()
    options.parent.removeEventListener('abort', onParentAbort)
  }
  const abort = (reason: unknown): void => { close(); controller.abort(reason) }
  const onParentAbort = (): void => abort(options.parent.reason)
  const refresh = (): void => {
    if (closed) return
    const next = options.isWaiting()
    if (waiting === next) return
    waiting = next
    timer?.abort()
    if (waiting) return
    const current = new AbortController()
    timer = current
    void options.clock.sleep(120, current.signal).then(() => {
      if (closed || current.signal.aborted) return
      if (options.isWaiting()) { refresh(); return }
      abort(new DOMException('Conversation turn timed out', 'TimeoutError'))
    }, error => {
      if (!closed && !current.signal.aborted) abort(error)
    })
  }
  if (options.parent.aborted) onParentAbort()
  else {
    options.parent.addEventListener('abort', onParentAbort, {once: true})
    unsubscribe = options.subscribe(refresh)
    if (closed) unsubscribe()
    else refresh()
  }
  return {signal: controller.signal, close}
}
