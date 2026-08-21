import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validProgressSummary } from '../src/events.js'
import {
  LETTER_CATEGORY_RANGE_COUNT,
  NUMBER_CATEGORY_RANGE_COUNT,
  OTHER_CATEGORY_RANGE_COUNT,
  PINNED_UNICODE_VERSION,
  PUNCTUATION_CATEGORY_RANGE_COUNT,
  hasOtherCategory,
  hasPunctuationCategory,
  isLetterCategory,
  isNumberCategory,
  isOtherCategory,
  isPunctuationCategory,
} from '../src/unicode-tables.js'

test('the pinned table decodes to the generated range set', () => {
  assert.equal(PINNED_UNICODE_VERSION, '15.0.0')
  assert.equal(OTHER_CATEGORY_RANGE_COUNT, 712)
})

test('pinned classification matches Python unicodedata at 15.0.0', () => {
  // Cc, Cf, Cs, Co, and Cn respectively.
  for (const codePoint of [0x00, 0x1f, 0x7f, 0x9f, 0xad, 0x200b, 0xd800, 0xdfff, 0xe000, 0xf8ff]) {
    assert.equal(isOtherCategory(codePoint), true, `U+${codePoint.toString(16)}`)
  }
  // Assigned, non-C at 15.0.0: Latin, CJK, an emoji, and an astral letter.
  for (const codePoint of [0x41, 0x61, 0x5ba2, 0x1f600, 0x10000, 0x2e]) {
    assert.equal(isOtherCategory(codePoint), false, `U+${codePoint.toString(16)}`)
  }
})

test('code points assigned after 15.0.0 stay rejected, unlike a bare \\p{C}', () => {
  // These are Cn at Unicode 15.0.0 and assigned symbols at 16.0. The host ICU
  // says assigned, so /\p{C}/u would accept them and diverge from the Python
  // oracle that exported every committed fixture.
  for (const codePoint of [0x1cc00, 0x1e5d0, 0x10d40]) {
    const character = String.fromCodePoint(codePoint)
    assert.equal(isOtherCategory(codePoint), true, `U+${codePoint.toString(16)} must be C at 15.0.0`)
    assert.equal(hasOtherCategory(character), true)
    assert.equal(
      validProgressSummary(`working on ${character}`, 'working'),
      false,
      'a summary carrying a post-15.0.0 code point must be rejected like Python does',
    )
    // Guard the premise: if a future ICU stops disagreeing this test still holds,
    // but the disagreement it documents is real today.
    assert.equal(/\p{C}/u.test(character), false, 'host ICU still classifies this as assigned')
  }
})

test('ranges are sorted, disjoint, and reject non-code-points', () => {
  let previousEnd = -2
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (!isOtherCategory(codePoint)) continue
    assert.ok(codePoint > previousEnd, 'classification must be monotone over a scan')
    previousEnd = codePoint
  }
  assert.throws(() => isOtherCategory(-1), RangeError)
  assert.throws(() => isOtherCategory(0x110000), RangeError)
  assert.throws(() => isOtherCategory(1.5), RangeError)
})

test('progress summary bounds still count code points, not UTF-16 units', () => {
  const astral = '\u{1f600}'
  assert.equal(validProgressSummary(astral.repeat(400), 'working'), true)
  assert.equal(validProgressSummary(astral.repeat(401), 'working'), false)
  assert.equal(validProgressSummary('', 'working'), false)
  assert.equal(validProgressSummary(null, 'started'), true)
  assert.equal(validProgressSummary('anything', 'started'), false)
})

test('the punctuation table decodes to the generated range set', () => {
  assert.equal(PUNCTUATION_CATEGORY_RANGE_COUNT, 191)
})

test('pinned punctuation classification matches Python unicodedata at 15.0.0', () => {
  // One from each P subcategory: Pc, Pd, Ps, Pe, Pi, Pf, Po.
  const punctuation = [
    0x5f, // _  connector
    0x2d, // -  dash
    0x28, // (  open
    0x29, // )  close
    0xab, // «  initial quote
    0xbb, // »  final quote
    0x21, // !  other
    0x3001, // 、 CJK ideographic comma, which a Chinese confirmation utterance carries
    0xff01, // ！ fullwidth exclamation
    0x2026, // … ellipsis
  ]
  for (const codePoint of punctuation) {
    assert.equal(isPunctuationCategory(codePoint), true, `U+${codePoint.toString(16)}`)
  }
  // Not punctuation: letters, digits, space (Zs), a symbol (Sm), and a currency sign (Sc).
  for (const codePoint of [0x41, 0x61, 0x30, 0x20, 0x597d, 0x2b, 0x24, 0x1f600]) {
    assert.equal(isPunctuationCategory(codePoint), false, `U+${codePoint.toString(16)}`)
  }
})

test('the punctuation table is not a \\p{P} escape in disguise', () => {
  // The whole reason for the table. If these ever agree everywhere, the table is still correct --
  // but it is the pinned answer either way, which a host escape is not.
  let scanned = 0
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (isPunctuationCategory(codePoint)) scanned += 1
  }
  assert.equal(scanned, 842, 'the pinned punctuation set covers exactly this many code points')
})

test('punctuation ranges are sorted, disjoint, and reject non-code-points', () => {
  let previousEnd = -2
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (!isPunctuationCategory(codePoint)) continue
    assert.ok(codePoint > previousEnd, 'classification must be monotone over a scan')
    previousEnd = codePoint
  }
  for (const invalid of [-1, 0x110000, 1.5, Number.NaN]) {
    assert.throws(() => isPunctuationCategory(invalid), RangeError)
  }
})

test('a string predicate finds punctuation anywhere in it', () => {
  assert.equal(hasPunctuationCategory('好的'), false)
  assert.equal(hasPunctuationCategory('好的。'), true, 'a trailing ideographic full stop counts')
  assert.equal(hasPunctuationCategory(''), false)
  // An astral character must not be split into surrogates by the scan.
  assert.equal(hasPunctuationCategory('\u{1f600}'), false)
})

test('pinned letter and number categories implement Python isalnum without ambient ICU', () => {
  assert.equal(LETTER_CATEGORY_RANGE_COUNT, 659)
  assert.equal(NUMBER_CATEGORY_RANGE_COUNT, 137)
  for (const codePoint of [0x41, 0x00aa, 0x4e00, 0x10400]) {
    assert.equal(isLetterCategory(codePoint), true, `U+${codePoint.toString(16)}`)
  }
  for (const codePoint of [0x30, 0x00b2, 0x0bf0, 0x2160, 0x1d7ce]) {
    assert.equal(isNumberCategory(codePoint), true, `U+${codePoint.toString(16)}`)
  }
  for (const codePoint of [0x20, 0x2d, 0x301, 0x24, 0x1f600]) {
    assert.equal(isLetterCategory(codePoint), false, `U+${codePoint.toString(16)}`)
    assert.equal(isNumberCategory(codePoint), false, `U+${codePoint.toString(16)}`)
  }
})
