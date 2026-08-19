/**
 * NFKC and lowercasing pinned to the Unicode version the committed fixtures were exported against.
 *
 * `String.prototype.normalize` and `toLowerCase` both follow the host ICU, which is ahead of the
 * database CPython bundles. Measuring the gap rather than assuming it (see
 * `fixtures/runtime/unicode-nfkc-vectors.json` and `runtime/test/unicode-nfkc.test.ts`) found it to
 * be narrow and to have a single cause: code points **assigned in a Unicode version newer than the
 * pin**. The pinned database has never heard of them, so it does nothing to them at all -- neither
 * decomposition nor case mapping -- while ICU applies both.
 *
 * The gap is not cosmetic. Of the sixty-three code points involved, thirty-six carry a compatibility
 * decomposition to an ASCII letter or digit and twenty-seven are uppercase letters with a case
 * mapping. Both land squarely in `realtime/recall.py`'s tokenizer domain, so under the host an
 * outlined `𜳰` would tokenize as `0` and match a memory containing a zero where the oracle matches
 * nothing. Which memories a model is shown is contract-visible.
 *
 * What is held back is **every code point the pin calls unassigned**, decided by the generated
 * category table rather than by a list. That is deliberately broader than the code points the host
 * visibly transforms: `U+16D63 U+16D68` are each unchanged by NFKC alone, so a set derived from
 * single-character behavior would have missed them -- yet together ICU composes them into `U+16D6A`
 * where CPython returns the pair untouched. Any pair of newly-assigned code points could compose that
 * way, so the pin's ignorance of a code point is itself the reason to leave it alone. The rule needs
 * no maintenance as ICU advances.
 */

import { PINNED_UNICODE_VERSION, isOtherCategory } from './unicode-tables.js'

export { PINNED_UNICODE_VERSION }

/**
 * Whether the pinned database treats this code point as unassigned.
 *
 * `isOtherCategory` answers from the generated table, so this is exactly the question CPython would
 * answer at the pin. Every such code point is held back, whether or not the host transforms it *in
 * isolation* -- which is the part that matters and the part an earlier version of this module got
 * wrong.
 *
 * Deriving the set from single-code-point behavior misses contextual composition. `U+16D63 U+16D68`
 * are both unassigned at the pin and both unchanged by NFKC on their own, so neither looked like a
 * divergence; together ICU composes them into `U+16D6A` while CPython returns the pair untouched.
 * Any pair of newly-assigned code points could compose that way, so the only safe rule is that the
 * pin's ignorance of a code point is itself the reason to hold it back.
 */
function isUnassignedAtPin(codePoint: number): boolean {
  // Surrogates are not scalar values and cannot appear in a well-formed string.
  if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) return false
  return isOtherCategory(codePoint)
}

/**
 * The code points held back, listed for tests and diagnostics.
 *
 * Unassigned-at-the-pin covers most of the code space, so the list is restricted to what the host
 * actually transforms in isolation or in a pair -- the interesting subset. Membership itself is
 * decided by `isUnassignedAtPin`, not by this list.
 */
function deriveTransformedHoldback(): number[] {
  const transformed: number[] = []
  for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
    if (!isUnassignedAtPin(codePoint)) continue
    const character = String.fromCodePoint(codePoint)
    if (character.normalize('NFKC') !== character || character.toLowerCase() !== character) {
      transformed.push(codePoint)
    }
  }
  return transformed
}

/**
 * Code points unassigned at the pin that the host transforms on their own.
 *
 * A strict subset of what is held back, kept because it is the measurable part of the divergence and
 * the tests assert its exact membership. Sixty-three today: thirty-six with a compatibility
 * decomposition, twenty-seven with a case mapping.
 */
export const NFKC_HOLDBACK_CODE_POINTS: readonly number[] = deriveTransformedHoldback()

function holdsAny(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isUnassignedAtPin(codePoint)) return true
  }
  return false
}

/**
 * Apply a transform to the runs between held-back characters, leaving those characters alone.
 *
 * Cutting the string rather than substituting a placeholder, because a placeholder has to be a code
 * point that cannot appear in the input and no such code point exists -- private-use characters are
 * legal text, and an earlier version of this silently corrupted any input containing U+F0000.
 *
 * Splitting is sound for a reason specific to what is held back. Normalization is contextual in
 * general, but every held-back code point is unassigned in the pinned database, where it has
 * combining class zero and no decomposition -- so nothing composes across it there either. Splitting
 * on exactly those characters reproduces the pinned behavior rather than approximating it, and it is
 * also what keeps two adjacent held-back characters from composing with *each other* under the host.
 */
function betweenHeldBack(text: string, transform: (run: string) => string): string {
  if (!holdsAny(text)) return transform(text)
  let result = ''
  let run = ''
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && isUnassignedAtPin(codePoint)) {
      result += transform(run) + character
      run = ''
      continue
    }
    run += character
  }
  return result + transform(run)
}

/**
 * NFKC as the pinned Unicode version would compute it.
 *
 * Use this anywhere the result is contract-visible -- recall scoring, confirmation matching, any text
 * a model or a golden will see. Plain `.normalize('NFKC')` is fine only for text that never leaves
 * the process.
 */
export function normalizeNfkcPinned(text: string): string {
  return betweenHeldBack(text, run => run.normalize('NFKC'))
}

/** Lowercase as the pinned Unicode version would compute it. */
export function toLowerPinned(text: string): string {
  return betweenHeldBack(text, run => run.toLowerCase())
}

/**
 * The pipeline `recall.py` runs: pinned NFKC, then pinned lowercase.
 *
 * Kept together because the two stages are only correct in this order -- lowercasing before
 * normalizing gives a different answer for some inputs, and the oracle normalizes first.
 */
export function normalizeAndLowerPinned(text: string): string {
  return toLowerPinned(normalizeNfkcPinned(text))
}
