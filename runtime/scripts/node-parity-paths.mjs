export function canonicalAuditPath(value) {
  if (typeof value !== 'string') throw new TypeError('audit path must be a string')
  return value.replaceAll('\\', '/')
}

export function isAuditedSource(value) {
  return canonicalAuditPath(value) !== 'runtime/src/unicode-tables.ts'
}
