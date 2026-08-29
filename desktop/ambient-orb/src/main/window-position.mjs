import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const MAX_DRAG_DELTA = 2048
export const NATURAL_ORB_WINDOW_SIZE = Object.freeze({width: 160, height: 160})
const CONFIRMATION_LAYOUT_CSS_HEIGHT = 160
const CONFIRMATION_ORB_CENTER_BELOW_CSS = 53
const CONFIRMATION_ORB_CENTER_ABOVE_CSS = 107

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
  const width = NATURAL_ORB_WINDOW_SIZE.width
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

/** Main-owned state machine for temporary confirmation bounds and their persisted natural anchor. */
export function createConfirmationWindowController({
  getBounds,
  setBounds,
  getZoomFactor,
  getWorkAreaForPoint,
  onPlacement,
}) {
  let normalBounds = null
  let activeLayout = null

  function sync() {
    if (normalBounds === null) return null
    const orbScreenCenter = rectangleCenter(normalBounds)
    const layout = confirmationWindowLayout({
      normalBounds,
      zoomFactor: getZoomFactor(),
      workArea: getWorkAreaForPoint(orbScreenCenter),
    })
    activeLayout = layout
    onPlacement(layout.placement)
    setBounds(layout.bounds)
    return layout
  }

  function setMode(active) {
    if (typeof active !== 'boolean') throw new TypeError('confirmation mode must be boolean')
    if (active) {
      if (normalBounds === null) {
        const current = getBounds()
        if (!validRectangle(current)) throw new TypeError('natural window bounds are invalid')
        normalBounds = {
          x: current.x,
          y: current.y,
          width: NATURAL_ORB_WINDOW_SIZE.width,
          height: NATURAL_ORB_WINDOW_SIZE.height,
        }
      }
      sync()
      return
    }
    if (normalBounds === null) return
    const restore = normalBounds
    normalBounds = null
    activeLayout = null
    onPlacement('below')
    setBounds(restore)
  }

  function clampDragPosition(candidate) {
    if (!validPosition(candidate)) throw new TypeError('drag position is invalid')
    if (activeLayout === null) {
      return clampWindowPosition(
        candidate,
        NATURAL_ORB_WINDOW_SIZE,
        getWorkAreaForPoint({
          x: candidate.x + Math.round(NATURAL_ORB_WINDOW_SIZE.width / 2),
          y: candidate.y + Math.round(NATURAL_ORB_WINDOW_SIZE.height / 2),
        }),
      )
    }
    const orbOffset = {
      x: activeLayout.renderedOrbScreenCenter.x - activeLayout.bounds.x,
      y: activeLayout.renderedOrbScreenCenter.y - activeLayout.bounds.y,
    }
    return clampWindowPosition(candidate, activeLayout.bounds, getWorkAreaForPoint({
      x: candidate.x + orbOffset.x,
      y: candidate.y + orbOffset.y,
    }))
  }

  function finishDrag(position) {
    if (!validPosition(position)) throw new TypeError('drag position is invalid')
    if (normalBounds === null || activeLayout === null) return position
    const provisional = {
      x: normalBounds.x + (position.x - activeLayout.bounds.x),
      y: normalBounds.y + (position.y - activeLayout.bounds.y),
    }
    const natural = naturalWindowPositionAfterTemporaryDrag({
      normalBounds,
      temporaryBounds: activeLayout.bounds,
      draggedPosition: position,
      workArea: getWorkAreaForPoint({
        x: provisional.x + Math.round(NATURAL_ORB_WINDOW_SIZE.width / 2),
        y: provisional.y + Math.round(NATURAL_ORB_WINDOW_SIZE.height / 2),
      }),
    })
    normalBounds = {...normalBounds, ...natural}
    sync()
    return natural
  }

  return Object.freeze({
    setMode,
    sync,
    clampDragPosition,
    finishDrag,
    get active() { return normalBounds !== null },
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
