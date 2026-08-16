export class OrbDragGesture {
  constructor(threshold = 6) {
    this.threshold = threshold
    this.active = false
    this.dragged = false
    this.suppressClick = false
  }

  start(x, y) {
    this.active = true
    this.dragged = false
    this.startX = this.lastX = x
    this.startY = this.lastY = y
  }

  move(x, y) {
    if (!this.active) return null
    if (!this.dragged && Math.hypot(x - this.startX, y - this.startY) < this.threshold) {
      return null
    }
    const dx = x - this.lastX
    const dy = y - this.lastY
    this.dragged = true
    this.lastX = x
    this.lastY = y
    return { dx, dy }
  }

  finish() {
    const result = { active: this.active, dragged: this.dragged }
    if (this.active) this.suppressClick = this.dragged
    this.active = false
    this.dragged = false
    return result
  }

  cancel() {
    const result = { active: this.active, dragged: this.dragged }
    this.active = false
    this.dragged = false
    this.suppressClick = false
    return result
  }

  consumeClick() {
    if (!this.suppressClick) return true
    this.suppressClick = false
    return false
  }
}
