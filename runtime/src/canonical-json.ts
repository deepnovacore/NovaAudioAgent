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
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('number is not JSON serializable')
  return encoded
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!)
  const rightPoints = Array.from(right, character => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}
