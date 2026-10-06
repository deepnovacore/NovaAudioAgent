import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const MAX_DRAG_DELTA = 2048
export const NATURAL_ORB_WINDOW_SIZE = Object.freeze({width: 160, height: 160})
/**
 * The dormant surface. Unlike the confirmation and bubble layouts below — which
 * only ever grow around the natural anchor — dormancy shrinks past it, so this
 * is the one size that must also be reachable by the window's own minWidth /
 * minHeight constraints (see security.mjs; Electron clamps setBounds to them).
 */
export const DORMANT_ORB_WINDOW_SIZE = Object.freeze({width: 64, height: 64})
const CONFIRMATION_LAYOUT_CSS_HEIGHT = 160
const CONFIRMATION_ORB_CENTER_BELOW_CSS = 53
const CONFIRMATION_ORB_CENTER_ABOVE_CSS = 107
const BUBBLE_WIDTH_CSS = 360
const BUBBLE_ROW_HEIGHT_CSS = 56

function normalizedPosition(value) {
  if (!value || !Number.isInteger(value.x) || !Number.isInteger(value.y)) return null
  return { x: value.x, y: value.y }
}

export function validDragDelta(dx, dy) {
  return Number.isFinite(dx) && Number.isFinite(dy)
    && Math.abs(dx) <= MAX_DRAG_DELTA && Math.abs(dy) <= MAX_DRAG_DELTA
}

export function clampWindowPosition(position, size, workArea) {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)
  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), maxY)),
  }
}

/**
 * Shrink the window around the anchor's centre rather than its origin.
 *
 * Keeping the centre fixed is the whole trick: the orb is drawn centred in its
 * window, so anchoring the shrink anywhere else would make the bubble jump
 * across the screen on every sleep and wake.
 */
export function dormantWindowLayout({normalBounds, workArea}) {
  if (!validRectangle(normalBounds) || !validRectangle(workArea)) {
    throw new TypeError('dormant window geometry is invalid')
  }
  const centre = rectangleCenter(normalBounds)
  const origin = clampWindowPosition(
    {
      x: Math.round(centre.x - DORMANT_ORB_WINDOW_SIZE.width / 2),
      y: Math.round(centre.y - DORMANT_ORB_WINDOW_SIZE.height / 2),
    },
    DORMANT_ORB_WINDOW_SIZE,
    workArea,
  )
  const bounds = {
    x: origin.x,
    y: origin.y,
    width: DORMANT_ORB_WINDOW_SIZE.width,
    height: DORMANT_ORB_WINDOW_SIZE.height,
  }
  return Object.freeze({
    bounds: Object.freeze(bounds),
    renderedOrbScreenCenter: Object.freeze(rectangleCenter(bounds)),
  })
}

/**
 * Compute one temporary confirmation surface without trusting renderer geometry.
 *
 * The natural 160x160 window center is the persisted Orb anchor. At elevated Chromium zoom the
 * height grows just enough to retain a 160 CSS-pixel confirmation layout; width never changes.
 */
export function confirmationWindowLayout({normalBounds, zoomFactor, workArea}) {
  if (!validRectangle(normalBounds) || !validRectangle(workArea)) {
    throw new TypeError('confirmation window geometry is invalid')
  }
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor > 5) {
    throw new RangeError('confirmation zoom factor is invalid')
  }
  const width = Math.max(
    NATURAL_ORB_WINDOW_SIZE.width,
    Math.ceil(CONFIRMATION_LAYOUT_CSS_HEIGHT * zoomFactor),
  )
  const height = Math.max(
    NATURAL_ORB_WINDOW_SIZE.height,
    Math.ceil(CONFIRMATION_LAYOUT_CSS_HEIGHT * zoomFactor),
  )
  const orbScreenCenter = {
    x: normalBounds.x + Math.round(normalBounds.width / 2),
    y: normalBounds.y + Math.round(normalBounds.height / 2),
  }
  const candidate = placement => {
    const orbOffset = confirmationOrbOffset(placement, zoomFactor)
    return {
      placement,
      orbOffset,
      position: {
        x: orbScreenCenter.x - Math.round(width / 2),
        y: Math.round(orbScreenCenter.y - orbOffset),
      },
    }
  }
  const below = candidate('below')
  const above = candidate('above')
  const selected = fitsWorkArea(below.position, {width, height}, workArea)
    ? below
    : fitsWorkArea(above.position, {width, height}, workArea) ? above : leastOverflowing(
      below,
      above,
      {width, height},
      workArea,
    )
  const position = clampWindowPosition(selected.position, {width, height}, workArea)
  const bounds = Object.freeze({...position, width, height})
  return Object.freeze({
    placement: selected.placement,
    bounds,
    orbScreenCenter: Object.freeze(orbScreenCenter),
    renderedOrbScreenCenter: Object.freeze({
      x: bounds.x + Math.round(width / 2),
      y: bounds.y + selected.orbOffset,
    }),
  })
}

/**
 * Reserve the native surface a renderer needs for a task card and up to three progress bubbles.
 * BrowserWindow bounds are Electron DIPs, so display scale is deliberately not
 * multiplied here: Chromium's CSS-to-backing-pixel conversion already owns it.
 */
export function bubbleWindowLayout({
  normalBounds,
  rows,
  taskRows = 0,
  zoomFactor,
  scaleFactor,
  workArea,
  confirmationActive = false,
}) {
  if (!validRectangle(normalBounds) || !validRectangle(workArea)) {
    throw new TypeError('bubble window geometry is invalid')
  }
  if (!Number.isInteger(rows) || rows < 0 || rows > 6 || !Number.isInteger(taskRows) || taskRows < 0 || taskRows > 5 || (rows === 0 && taskRows === 0)) {
    throw new RangeError('bubble rows are invalid')
  }
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor > 5
    || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError('bubble scale is invalid')
  }
  const bubbleHeight = Math.ceil(BUBBLE_ROW_HEIGHT_CSS * rows * zoomFactor)
  const bubbleWidth = Math.max(
    NATURAL_ORB_WINDOW_SIZE.width,
    Math.ceil((rows ? BUBBLE_WIDTH_CSS : 332) * zoomFactor),
  )
  const orbScreenCenter = rectangleCenter(normalBounds)
  const x = clampWindowPosition({
    x: orbScreenCenter.x - Math.round(bubbleWidth / 2),
    y: workArea.y,
  }, {width: bubbleWidth, height: 1}, workArea).x
  // Keep the full 160 CSS-pixel orb/controls surface inside the window at zoomed edges.
  const orbMargin = 80 * zoomFactor
  const orbOffsetX = Math.max(orbMargin, Math.min(bubbleWidth - orbMargin, orbScreenCenter.x - x))
  const bubbleAlignment = orbOffsetX < Math.round(bubbleWidth / 2)
    ? 'left'
    : orbOffsetX > Math.round(bubbleWidth / 2) ? 'right' : 'center'
  const layout = confirmationActive
    ? bubbleConfirmationLayout({
        normalBounds,
        zoomFactor,
        bubbleHeight,
        bubbleWidth,
        x,
        workArea,
      })
    : bubbleOnlyLayout({
        normalBounds,
        zoomFactor,
        bubbleHeight,
        bubbleWidth,
        taskRows,
        x,
        workArea,
      })
  if (layout.suppressed) {
    return Object.freeze({
      ...layout,
      bounds: Object.freeze(layout.position),
      bubbleAlignment,
      bubbleHeight,
      confirmationPlacement: layout.confirmationPlacement,
      orbOffsetCssX: layout.orbOffsetX / zoomFactor,
      orbOffsetCssY: layout.orbOffsetY / zoomFactor,
      renderedOrbScreenCenter: Object.freeze({
        x: layout.position.x + layout.orbOffsetX,
        y: layout.position.y + layout.orbOffsetY,
      }),
    })
  }
  const bounds = Object.freeze({...layout.position, width: bubbleWidth, height: layout.height})
  const clamped = Object.freeze({
    ...clampWindowPosition(bounds, bounds, workArea),
    width: bounds.width,
    height: bounds.height,
  })
  return Object.freeze({
    ...layout,
    bounds: clamped,
    suppressed: false,
    bubbleAlignment,
    bubbleHeight,
    bubblePlacement: layout.bubblePlacement,
    confirmationPlacement: layout.confirmationPlacement || null,
    orbOffsetCssX: orbOffsetX / zoomFactor,
    orbOffsetCssY: layout.orbOffsetY / zoomFactor,
    renderedOrbScreenCenter: Object.freeze({
      x: clamped.x + orbOffsetX,
      y: clamped.y + layout.orbOffsetY,
    }),
  })
}

function bubbleOnlyLayout({normalBounds, zoomFactor, bubbleHeight, bubbleWidth, taskRows = 0, x, workArea}) {
  // 55px above the center joins the chat tail; 125px below holds status and workspace.
  const naturalHeight = Math.ceil(180 * zoomFactor)
  if (naturalHeight + bubbleHeight > workArea.height || bubbleWidth > workArea.width) {
    return {suppressed: true, bubblePlacement: 'above', position: normalBounds,
      height: normalBounds.height, orbOffsetX: normalBounds.width / 2, orbOffsetY: normalBounds.height / 2}
  }
  const orbOffset = 55 * zoomFactor
  const available = Math.floor((workArea.height - naturalHeight - bubbleHeight) / zoomFactor)
  const taskHeightCss = taskRows && available >= 102 ? Math.min(taskRows * 72 + 30, available) : 0
  return {
    taskHeightCss,
    bubblePlacement: 'above',
    position: {x, y: rectangleCenter(normalBounds).y - bubbleHeight - orbOffset},
    height: naturalHeight + bubbleHeight + Math.ceil(taskHeightCss * zoomFactor),
    orbOffsetY: bubbleHeight + orbOffset,
  }
}

function bubbleConfirmationLayout({normalBounds, zoomFactor, bubbleHeight, bubbleWidth, x, workArea}) {
  const confirmation = confirmationWindowLayout({normalBounds, zoomFactor, workArea})
  const confirmationHeight = confirmation.bounds.height
  const candidates = confirmation.placement === 'below'
    ? [{
        bubblePlacement: 'above',
        confirmationPlacement: 'below',
        position: {
          x,
          y: confirmation.orbScreenCenter.y - bubbleHeight
            - (confirmation.renderedOrbScreenCenter.y - confirmation.bounds.y),
        },
        height: confirmationHeight + bubbleHeight,
        orbOffsetY: bubbleHeight + confirmation.renderedOrbScreenCenter.y - confirmation.bounds.y,
      }]
    : [{
        bubblePlacement: 'below',
        confirmationPlacement: 'above',
        position: {
          x,
          y: confirmation.orbScreenCenter.y
            - (confirmation.renderedOrbScreenCenter.y - confirmation.bounds.y),
        },
        height: confirmationHeight + bubbleHeight,
        orbOffsetY: confirmation.renderedOrbScreenCenter.y - confirmation.bounds.y,
      }]
  const selected = candidates[0]
  return fitsWorkArea(selected.position, {width: bubbleWidth, height: selected.height}, workArea)
    ? selected
    : {
        ...selected,
        suppressed: true,
        position: confirmation.bounds,
        height: confirmation.bounds.height,
        orbOffsetX: confirmation.renderedOrbScreenCenter.x - confirmation.bounds.x,
        orbOffsetY: confirmation.renderedOrbScreenCenter.y - confirmation.bounds.y,
      }
}

/** Sole owner for confirmation and bubble bounds, anchored to the persisted 160 DIP orb. */
export function createOrbWindowController({
  getBounds,
  setBounds,
  getZoomFactor,
  getScaleFactor,
  getWorkAreaForPoint,
  onConfirmationPlacement,
  onBubbleLayout = () => {},
}) {
  let normalBounds = null
  let confirmationActive = false
  let rows = 0, taskRows = 0
  let activeLayout = null
  let dormant = false

  function ensureNormalBounds() {
    if (normalBounds !== null) return
    const current = getBounds()
    if (!validRectangle(current)) throw new TypeError('natural window bounds are invalid')
    normalBounds = {
      x: current.x,
      y: current.y,
      width: NATURAL_ORB_WINDOW_SIZE.width,
      height: NATURAL_ORB_WINDOW_SIZE.height,
    }
  }

  function restoreIfNatural() {
    if (confirmationActive || rows > 0 || taskRows > 0 || dormant || normalBounds === null) return false
    setBounds(normalBounds)
    normalBounds = null
    activeLayout = null
    onConfirmationPlacement('below')
    onBubbleLayout(Object.freeze({rows: 0, suppressed: false, bubblePlacement: 'above'}))
    return true
  }

  function sync() {
    if (normalBounds === null) return null
    const center = rectangleCenter(normalBounds)
    const workArea = getWorkAreaForPoint(center)
    if (rows > 0 || taskRows > 0) {
      const layout = bubbleWindowLayout({
        normalBounds,
        rows,
        taskRows,
        zoomFactor: getZoomFactor(),
        scaleFactor: getScaleFactor(),
        workArea,
        confirmationActive,
      })
      if (layout.suppressed) {
        const confirmation = confirmationWindowLayout({
          normalBounds,
          zoomFactor: getZoomFactor(),
          workArea,
        })
        activeLayout = confirmation
        onConfirmationPlacement(confirmation.placement)
        onBubbleLayout(Object.freeze({...layout, rows}))
        setBounds(confirmation.bounds)
        return Object.freeze({...layout, rows})
      }
      activeLayout = layout
      onConfirmationPlacement(layout.confirmationPlacement || 'below')
      onBubbleLayout(Object.freeze({...layout, rows}))
      setBounds(layout.bounds)
      return Object.freeze({...layout, rows})
    }
    if (confirmationActive) {
      const layout = confirmationWindowLayout({
        normalBounds,
        zoomFactor: getZoomFactor(),
        workArea,
      })
      activeLayout = layout
      onConfirmationPlacement(layout.placement)
      onBubbleLayout(Object.freeze({rows: 0, suppressed: false, bubblePlacement: 'above'}))
      setBounds(layout.bounds)
      return layout
    }
    // Dormancy yields to both surfaces above: a confirmation card or a stack of
    // progress bubbles cannot be shown on a 64px window, and either arriving
    // means something wants the user's attention, which is the opposite of
    // resting. It is checked last for exactly that reason.
    if (dormant) {
      const layout = dormantWindowLayout({normalBounds, workArea})
      activeLayout = layout
      setBounds(layout.bounds)
      return layout
    }
    restoreIfNatural()
    return null
  }

  function setDormant(active) {
    if (typeof active !== 'boolean') throw new TypeError('dormant mode must be boolean')
    if (active === dormant) return activeLayout
    if (active) ensureNormalBounds()
    dormant = active
    return sync()
  }

  function setConfirmationMode(active) {
    if (typeof active !== 'boolean') throw new TypeError('confirmation mode must be boolean')
    if (active) ensureNormalBounds()
    confirmationActive = active
    return sync()
  }

  function reserveBubbleArea(nextRows, nextTaskRows = 0) {
    if (!Number.isInteger(nextRows) || nextRows < 0 || nextRows > 6 || !Number.isInteger(nextTaskRows) || nextTaskRows < 0 || nextTaskRows > 5) {
      throw new RangeError('bubble rows are invalid')
    }
    if (nextRows > 0 || nextTaskRows > 0) ensureNormalBounds()
    rows = nextRows
    taskRows = nextTaskRows
    return sync() || Object.freeze({rows: 0, suppressed: false, bubblePlacement: 'above'})
  }

  function clampDragPosition(candidate) {
    if (!validPosition(candidate)) throw new TypeError('drag position is invalid')
    const layout = activeLayout
    if (layout === null) {
      return clampWindowPosition(candidate, NATURAL_ORB_WINDOW_SIZE, getWorkAreaForPoint({
        x: candidate.x + 80, y: candidate.y + 80,
      }))
    }
    const offset = layout.renderedOrbScreenCenter
      ? {
          x: layout.renderedOrbScreenCenter.x - layout.bounds.x,
          y: layout.renderedOrbScreenCenter.y - layout.bounds.y,
        }
      : {x: 80, y: 80}
    return clampWindowPosition(candidate, layout.bounds, getWorkAreaForPoint({
      x: candidate.x + offset.x,
      y: candidate.y + offset.y,
    }))
  }

  function finishDrag(position) {
    if (!validPosition(position)) throw new TypeError('drag position is invalid')
    if (normalBounds === null || activeLayout === null) return position
    const offset = {
      x: activeLayout.renderedOrbScreenCenter.x - activeLayout.bounds.x,
      y: activeLayout.renderedOrbScreenCenter.y - activeLayout.bounds.y,
    }
    const natural = clampWindowPosition({
      x: normalBounds.x + (position.x - activeLayout.bounds.x),
      y: normalBounds.y + (position.y - activeLayout.bounds.y),
    }, NATURAL_ORB_WINDOW_SIZE, getWorkAreaForPoint({
      x: position.x + offset.x,
      y: position.y + offset.y,
    }))
    normalBounds = {...normalBounds, ...natural}
    sync()
    return natural
  }

  return Object.freeze({
    setConfirmationMode,
    setDormant,
    reserveBubbleArea,
    sync,
    clampDragPosition,
    finishDrag,
    get active() { return normalBounds !== null },
    get dormant() { return dormant },
    get bubblesSuppressed() { return rows > 0 && activeLayout?.suppressed === true },
  })
}

function confirmationOrbOffset(placement, zoomFactor) {
  const cssOffset = placement === 'above'
    ? CONFIRMATION_ORB_CENTER_ABOVE_CSS
    : CONFIRMATION_ORB_CENTER_BELOW_CSS
  return Math.round(cssOffset * zoomFactor)
}

function fitsWorkArea(position, size, workArea) {
  return position.x >= workArea.x
    && position.y >= workArea.y
    && position.x + size.width <= workArea.x + workArea.width
    && position.y + size.height <= workArea.y + workArea.height
}

function leastOverflowing(first, second, size, workArea) {
  return overflow(first.position, size, workArea) <= overflow(second.position, size, workArea)
    ? first
    : second
}

function overflow(position, size, workArea) {
  return Math.max(0, workArea.x - position.x)
    + Math.max(0, workArea.y - position.y)
    + Math.max(0, position.x + size.width - (workArea.x + workArea.width))
    + Math.max(0, position.y + size.height - (workArea.y + workArea.height))
}

function validPosition(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
}

function rectangleCenter(rectangle) {
  return {
    x: rectangle.x + Math.round(rectangle.width / 2),
    y: rectangle.y + Math.round(rectangle.height / 2),
  }
}

function validRectangle(value) {
  return validPosition(value)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0
}

export async function loadWindowPosition(file) {
  try {
    return normalizedPosition(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

export async function saveWindowPosition(file, position) {
  const normalized = normalizedPosition(position)
  if (!normalized) throw new TypeError('window position is invalid')
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
