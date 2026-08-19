import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validProgressSummary } from '../src/events.js'
import {
  OTHER_CATEGORY_RANGE_COUNT,
  PINNED_UNICODE_VERSION,
  hasOtherCategory,
  isOtherCategory,
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
