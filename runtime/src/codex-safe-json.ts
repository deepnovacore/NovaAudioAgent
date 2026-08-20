import {isWellFormed} from './python-text.js'

export function snapshotJsonValue(value: unknown): unknown {
  return snapshot(value, new Set<object>())
}

export function snapshotJsonRecord(value: unknown): Record<string, unknown> {
  const result = snapshotJsonValue(value)
  if (!isSnapshotRecord(result)) throw new TypeError('not a JSON object')
  return result
}

function snapshot(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError('invalid JSON number')
    }
    return value
  }
  if (typeof value === 'string') {
    if (!isWellFormed(value)) throw new TypeError('invalid JSON string')
    return value
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid JSON value')
  const prototype = Object.getPrototypeOf(value) as object | null
  const isArray = Array.isArray(value)
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('invalid JSON prototype')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  ancestors.add(value)
  try {
    return isArray
      ? snapshotArray(descriptors, ancestors)
      : snapshotRecord(descriptors, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function snapshotArray(
  descriptors: PropertyDescriptorMap,
  ancestors: Set<object>,
): unknown[] {
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => typeof key === 'symbol')) throw new TypeError('symbol JSON key')
  const lengthDescriptor = descriptors.length
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0
  ) throw new TypeError('invalid array length')
  const length = lengthDescriptor.value as number
  if (ownKeys.length !== length + 1) throw new TypeError('sparse or decorated array')
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('invalid array item')
    }
    result.push(snapshot(descriptor.value, ancestors))
  }
  return result
}

function snapshotRecord(
  descriptors: PropertyDescriptorMap,
  ancestors: Set<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !isWellFormed(key)) throw new TypeError('invalid JSON key')
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('invalid JSON property')
    }
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
