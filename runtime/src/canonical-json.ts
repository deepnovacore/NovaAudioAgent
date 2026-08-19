import { jsonValueSchema, type JsonValue } from './events.js'

export function canonicalJson(value: unknown): string {
  return serializeJson(jsonValueSchema.parse(value))
}

function serializeJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return serializeJsonNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(serializeJson).join(',')}]`

  const fields = Object.keys(value)
    .sort(compareCodePoints)
    .map(key => `${JSON.stringify(key)}:${serializeJson(value[key]!)}`)
  return `{${fields.join(',')}}`
}

function serializeJsonNumber(value: number): string {
  // JSON has one numeric kind, so canonical bytes depend on numeric value, not
  // whether a source language originally parsed an integral token as int or float.
  // `jsonValueSchema` already rejected NaN and the infinities, which are the only
  // numbers JSON.stringify would refuse to render as a number.
  return JSON.stringify(value)
}

/**
 * Order two strings by Unicode code point, the way Python `sorted` does.
 *
 * JavaScript's `<` compares UTF-16 code units, so a BMP character above the
 * surrogate range (U+E000, say) sorts before an astral character (U+10000) there
 * and after it by code point. Every ordering the two runtimes must agree on --
 * canonical object keys and sorted identities alike -- goes through this.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!)
  const rightPoints = Array.from(right, character => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}
