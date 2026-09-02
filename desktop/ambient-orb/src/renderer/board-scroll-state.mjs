export function captureBoardScrollPositions(document) {
  const positions = new Map()
  const page = document?.scrollingElement
  if (page) positions.set('page', readPosition(page))
  for (const element of document?.querySelectorAll?.('[data-scroll-key]') ?? []) {
    const key = element.dataset?.scrollKey
    if (key) positions.set(key, readPosition(element))
  }
  return positions
}

export function restoreBoardScrollPositions(document, positions) {
  const page = document?.scrollingElement
  const pagePosition = positions?.get('page')
  if (page && pagePosition) writePosition(page, pagePosition)
  for (const element of document?.querySelectorAll?.('[data-scroll-key]') ?? []) {
    const key = element.dataset?.scrollKey
    const position = key ? positions?.get(key) : undefined
    if (position) writePosition(element, position)
  }
}

export function diagnosticScrollKey(backendGeneration, record) {
  return `diagnostic:${backendGeneration}:${record.seq}`
}

function readPosition(element) {
  return {top: element.scrollTop, left: element.scrollLeft}
}

function writePosition(element, position) {
  element.scrollTop = position.top
  element.scrollLeft = position.left
}
