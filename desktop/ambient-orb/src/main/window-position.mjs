import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

export const MAX_DRAG_DELTA = 2048

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
