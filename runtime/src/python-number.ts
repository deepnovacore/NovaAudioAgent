/** Python `str(float)` for a finite IEEE-754 binary64 value. */
export function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`prompt float must be finite: ${value}`)
  }
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e16 || magnitude < 1e-4) {
    const [mantissa, exponent] = value.toExponential().split('e')
    const sign = exponent!.startsWith('-') ? '-' : '+'
    const digits = exponent!.replace(/^[+-]/, '').padStart(2, '0')
    return `${mantissa!}e${sign}${digits}`
  }
  const rendered = String(value)
  return rendered.includes('.') ? rendered : `${rendered}.0`
}
