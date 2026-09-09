export class Transcript {
  // ponytail: keep 300 session captions in memory; add paged host history if needed.
  constructor(limit = 300) { this.limit = limit; this.items = []; this.sequence = -1; this.nextId = 0 }
  newServer() { this.sequence = -1; for (const item of this.items) item.final = true }
  receive(frame) {
    if (!['user', 'assistant'].includes(frame.role) || typeof frame.text !== 'string'
      || frame.text.length > 32768 || typeof frame.final !== 'boolean'
      || !Number.isSafeInteger(frame.sequence) || frame.sequence <= this.sequence) return false
    this.sequence = frame.sequence
    if (!frame.text.trim()) {
      if (!frame.final) return false
      const count = this.items.length
      this.items = this.items.filter(item => item.role !== frame.role || item.final)
      return count !== this.items.length
    }
    const previous = this.items.findLast(item => item.role === frame.role && !item.final)
    if (previous) Object.assign(previous, {text: frame.text, final: frame.final})
    else this.items.push({id: ++this.nextId, role: frame.role, text: frame.text, final: frame.final})
    if (this.items.length > this.limit) this.items.shift()
    return true
  }
}
