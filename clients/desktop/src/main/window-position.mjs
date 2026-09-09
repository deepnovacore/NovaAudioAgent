import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const MAX_DRAG_DELTA = 2048
export const NATURAL_ORB_WINDOW_SIZE = Object.freeze({width: 160, height: 160})
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
  zoomFactor,
  scaleFactor,
  workArea,
  confirmationActive = false,
}) {
  if (!validRectangle(normalBounds) || !validRectangle(workArea)) {
    throw new TypeError('bubble window geometry is invalid')
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 6) {
    throw new RangeError('bubble rows are invalid')
  }
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor > 5
    || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError('bubble scale is invalid')
  }
  const bubbleHeight = Math.ceil(BUBBLE_ROW_HEIGHT_CSS * rows * zoomFactor)
  const bubbleWidth = Math.max(
    NATURAL_ORB_WINDOW_SIZE.width,
    Math.ceil(BUBBLE_WIDTH_CSS * zoomFactor),
  )
  const orbScreenCenter = rectangleCenter(normalBounds)
  const x = clampWindowPosition({
    x: orbScreenCenter.x - Math.round(bubbleWidth / 2),
    y: workArea.y,
  }, {width: bubbleWidth, height: 1}, workArea).x
  const orbOffsetX = orbScreenCenter.x - x
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

function bubbleOnlyLayout({normalBounds, zoomFactor, bubbleHeight, bubbleWidth, x, workArea}) {
  const naturalHeight = Math.max(NATURAL_ORB_WINDOW_SIZE.height, Math.ceil(160 * zoomFactor))
  if (naturalHeight + bubbleHeight > workArea.height || bubbleWidth > workArea.width) {
    return {suppressed: true, bubblePlacement: 'above', position: normalBounds,
      height: normalBounds.height, orbOffsetX: normalBounds.width / 2, orbOffsetY: normalBounds.height / 2}
  }
  const orbOffset = Math.round(naturalHeight / 2)
  const above = {
    bubblePlacement: 'above',
    position: {x, y: rectangleCenter(normalBounds).y - bubbleHeight - orbOffset},
    height: naturalHeight + bubbleHeight,
    orbOffsetY: bubbleHeight + orbOffset,
  }
  const below = {
    bubblePlacement: 'below',
    position: {x, y: rectangleCenter(normalBounds).y - orbOffset},
    height: naturalHeight + bubbleHeight,
    orbOffsetY: orbOffset,
  }
  return fitsWorkArea(above.position, {width: bubbleWidth, height: above.height}, workArea)
    ? above
    : fitsWorkArea(below.position, {width: bubbleWidth, height: below.height}, workArea)
      ? below
      : overflow(above.position, {width: bubbleWidth, height: above.height}, workArea)
        <= overflow(below.position, {width: bubbleWidth, height: below.height}, workArea) ? above : below
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

/** Translate a dragged temporary surface back to the natural 160x160 position persisted on disk. */
export function naturalWindowPositionAfterTemporaryDrag({
  normalBounds,
  temporaryBounds,
  draggedPosition,
  workArea,
}) {
  if (!validRectangle(normalBounds) || !validRectangle(temporaryBounds)
    || !validPosition(draggedPosition) || !validRectangle(workArea)) {
    throw new TypeError('confirmation drag geometry is invalid')
  }
  return clampWindowPosition({
    x: normalBounds.x + (draggedPosition.x - temporaryBounds.x),
    y: normalBounds.y + (draggedPosition.y - temporaryBounds.y),
  }, NATURAL_ORB_WINDOW_SIZE, workArea)
}

/**
 * Legacy confirmation API backed by the sole temporary-bounds owner below.
 * Existing call sites retain their narrow method names while bubbles share its state.
 */
export function createConfirmationWindowController(options) {
  const controller = createOrbWindowController({
    ...options,
    getScaleFactor: () => 1,
    onConfirmationPlacement: options.onPlacement,
  })
  return Object.freeze({
    setMode: controller.setConfirmationMode,
    sync: controller.sync,
    clampDragPosition: controller.clampDragPosition,
    finishDrag: controller.finishDrag,
    get active() { return controller.active },
  })
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
  let rows = 0
  let activeLayout = null

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
    if (confirmationActive || rows > 0 || normalBounds === null) return false
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
    if (rows > 0) {
      const layout = bubbleWindowLayout({
        normalBounds,
        rows,
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
    restoreIfNatural()
    return null
  }

  function setConfirmationMode(active) {
    if (typeof active !== 'boolean') throw new TypeError('confirmation mode must be boolean')
    if (active) ensureNormalBounds()
    confirmationActive = active
    return sync()
  }

  function reserveBubbleArea(nextRows) {
    if (!Number.isInteger(nextRows) || nextRows < 0 || nextRows > 6) {
      throw new RangeError('bubble rows are invalid')
    }
    if (nextRows > 0) ensureNormalBounds()
    rows = nextRows
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
    reserveBubbleArea,
    sync,
    clampDragPosition,
    finishDrag,
    get active() { return normalBounds !== null },
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
