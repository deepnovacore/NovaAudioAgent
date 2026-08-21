import { jsonValueSchema, type JsonValue } from './events.js'

export type CanonicalJsonPath = readonly (string | number)[]
export type CanonicalNumberFormatter = (
  value: number,
  path: CanonicalJsonPath,
) => string | undefined

const JSON_NUMBER_TOKEN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u

export function canonicalJson(value: unknown): string {
  return serializeJson(jsonValueSchema.parse(value), [], undefined)
}

/** Canonical JSON with a validated, path-aware spelling override for selected finite numbers. */
export function canonicalJsonWithNumberFormatter(
  value: unknown,
  formatter: CanonicalNumberFormatter,
): string {
  return serializeJson(jsonValueSchema.parse(value), [], formatter)
}

function serializeJson(
  value: JsonValue,
  path: CanonicalJsonPath,
  formatter: CanonicalNumberFormatter | undefined,
): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return serializeJsonNumber(value, path, formatter)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serializeJson(item, [...path, index], formatter)).join(',')}]`
  }

  const fields = Object.keys(value)
    .sort(compareCodePoints)
    .map(key => `${JSON.stringify(key)}:${serializeJson(value[key]!, [...path, key], formatter)}`)
  return `{${fields.join(',')}}`
}

function serializeJsonNumber(
  value: number,
  path: CanonicalJsonPath,
  formatter: CanonicalNumberFormatter | undefined,
): string {
  // JSON has one numeric kind, so canonical bytes depend on numeric value, not
  // whether a source language originally parsed an integral token as int or float.
  // `jsonValueSchema` already rejected NaN and the infinities, which are the only
  // numbers JSON.stringify would refuse to render as a number.
  const token = formatter?.(value, path)
  if (token === undefined) return JSON.stringify(value)
  const parsed = JSON_NUMBER_TOKEN.test(token) ? Number(token) : Number.NaN
  const equivalent = Object.is(value, -0) ? Object.is(parsed, -0) : Object.is(parsed, value)
  if (!equivalent) throw new TypeError('canonical number formatter returned an unsafe token')
  return token
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
