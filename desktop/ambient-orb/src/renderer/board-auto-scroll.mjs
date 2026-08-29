export function createBoardAutoScroller({
  document,
  requestFrame = callback => requestAnimationFrame(callback),
} = {}) {
  let pending = false
  return function scrollBoardToBottom() {
    if (pending) return
    pending = true
    requestFrame(() => {
      pending = false
      const targets = [
        document?.scrollingElement,
        ...document?.querySelectorAll?.('[data-auto-scroll-bottom]') ?? [],
      ]
      for (const target of new Set(targets)) {
        if (!target) continue
        target.scrollTop = target.scrollHeight
      }
    })
  }
}
