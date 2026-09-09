// Pure drag-position math: no Electron imports. Movement is derived entirely
// from injected main-process cursor reads (screen.getCursorScreenPoint on the
// caller's side), never from renderer-reported coordinates, so a window
// dragged across mixed-DPI displays or under Wayland tracks the OS cursor
// instead of a scaled-and-drifting renderer delta.
export function createDragController({ getCursor, getWindowPosition, setWindowPosition, clamp }) {
  let active = false
  let cursorStart = null
  let windowStart = null
  let lastPosition = null
  let moved = false

  function start() {
    active = true
    moved = false
    lastPosition = null
    cursorStart = getCursor()
    windowStart = getWindowPosition()
  }

  function tick() {
    if (!active) return
    const cursorNow = getCursor()
    const next = clamp({
      x: windowStart.x + (cursorNow.x - cursorStart.x),
      y: windowStart.y + (cursorNow.y - cursorStart.y),
    })
    setWindowPosition(next)
    lastPosition = next
    if (next.x !== windowStart.x || next.y !== windowStart.y) moved = true
  }

  function end() {
    if (!active) return { moved: false, position: null }
    active = false
    return { moved, position: lastPosition || windowStart }
  }

  return { start, tick, end }
}
