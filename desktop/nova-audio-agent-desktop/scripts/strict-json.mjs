export class StrictJsonError extends Error {
  constructor() {
    super('strict JSON rejected')
    this.name = 'StrictJsonError'
  }
}

export function parseStrictJson(text, { maximumDepth = 64 } = {}) {
  if (typeof text !== 'string') throw new StrictJsonError()
  let offset = 0

  const fail = () => { throw new StrictJsonError() }
  const whitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) offset += 1
  }
  const string = () => {
    if (text[offset] !== '"') fail()
    const start = offset
    offset += 1
    while (offset < text.length) {
      const code = text.charCodeAt(offset)
      if (code === 0x22) {
        offset += 1
        try {
          return JSON.parse(text.slice(start, offset))
        } catch {
          fail()
        }
      }
      if (code < 0x20) fail()
      if (code === 0x5c) {
        offset += 1
        if (offset >= text.length) fail()
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) fail()
          offset += 5
          continue
        }
        if (!/["\\/bfnrt]/u.test(text[offset])) fail()
      }
      offset += 1
    }
    fail()
  }
  const value = depth => {
    if (depth > maximumDepth) fail()
    whitespace()
    if (text[offset] === '"') return string()
    if (text[offset] === '{') {
      offset += 1
      whitespace()
      const result = {}
      const keys = new Set()
      if (text[offset] === '}') {
        offset += 1
        return result
      }
      while (offset < text.length) {
        whitespace()
        const key = string()
        if (keys.has(key)) fail()
        keys.add(key)
        whitespace()
        if (text[offset] !== ':') fail()
        offset += 1
        const child = value(depth + 1)
        Object.defineProperty(result, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        })
        whitespace()
        if (text[offset] === '}') {
          offset += 1
          return result
        }
        if (text[offset] !== ',') fail()
        offset += 1
      }
      fail()
    }
    if (text[offset] === '[') {
      offset += 1
      whitespace()
      const result = []
      if (text[offset] === ']') {
        offset += 1
        return result
      }
      while (offset < text.length) {
        result.push(value(depth + 1))
        whitespace()
        if (text[offset] === ']') {
          offset += 1
          return result
        }
        if (text[offset] !== ',') fail()
        offset += 1
      }
      fail()
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length
        return parsed
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset))?.[0]
    if (number === undefined) fail()
    offset += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed)) fail()
    return parsed
  }

  const parsed = value(0)
  whitespace()
  if (offset !== text.length) fail()
  return parsed
}
