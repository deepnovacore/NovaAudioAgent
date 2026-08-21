/**
 * String operations that have to agree with CPython's, character for character.
 *
 * These live together because each one is a place the two runtimes look identical and are not, and
 * because each has now been needed more than once -- the first was found in recall, the second in
 * Search, and re-deriving them per module is how one of them ends up subtly different.
 */

/**
 * Code points `str.isspace()` calls whitespace and `String.prototype.trim` does not.
 *
 * The two predicates disagree in *both* directions across the whole code space, and exactly six code
 * points are involved: these five, plus U+FEFF in the other direction. A test derives the same set from
 * the two predicates rather than trusting this list.
 */
const PYTHON_ONLY_SPACE: ReadonlySet<string> = new Set([
  '\u001c',
  '\u001d',
  '\u001e',
  '\u001f',
  '\u0085',
])

/** Whether Python's `str.isspace()` would be true for this character. */
export function isPythonSpace(character: string): boolean {
  // U+FEFF is whitespace to `trim` and a format character to Python.
  if (character === '\ufeff') return false
  return PYTHON_ONLY_SPACE.has(character) || character.trim() === ''
}

/**
 * Strip leading and trailing whitespace the way Python's `str.strip()` does.
 *
 * Using `trim()` instead leaves U+001C..U+001F and U+0085 attached and removes U+FEFF, so a value the
 * oracle considers blank arrives here non-blank and vice versa. Where that value decides whether a
 * result is usable evidence, the two runtimes then disagree about what the provider returned.
 */
export function stripLikePython(text: string): string {
  const characters = [...text]
  let start = 0
  let end = characters.length
  while (start < end && isPythonSpace(characters[start]!)) start += 1
  while (end > start && isPythonSpace(characters[end - 1]!)) end -= 1
  return characters.slice(start, end).join('')
}

/** Count Unicode code points exactly as Python's `len(str)` does. */
export function codePointLengthLikePython(text: string): number {
  return [...text].length
}

/**
 * Whether a string can be encoded as UTF-8 at all.
 *
 * A lone surrogate cannot: Python's `.encode()` raises `UnicodeEncodeError`, while JavaScript's
 * `JSON.stringify` quietly escapes it and `TextEncoder` substitutes U+FFFD. So the same provider
 * response either fails outright or produces a digest, depending on the runtime -- and that digest is a
 * citation the model would then be handed.
 */
export function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd8_00 && unit <= 0xdb_ff) {
      const next = text.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc_00 || next > 0xdf_ff) return false
      index += 1
    } else if (unit >= 0xdc_00 && unit <= 0xdf_ff) {
      return false
    }
  }
  return true
}
