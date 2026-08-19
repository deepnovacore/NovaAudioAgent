/**
 * Does V8's NFKC agree with CPython's, on the inputs this migration depends on?
 *
 * Python normalizes with the Unicode database bundled into CPython; V8 with the one bundled into
 * ICU, currently a newer version. `realtime/recall.py` feeds the result into lexical scoring, so a
 * divergence changes which memories a model is shown -- contract-visible, not cosmetic.
 *
 * The backlog recorded this as "not practically pinnable" and offered two options: vendor a
 * normalization table, or accept a documented tolerance. This test decides between them with
 * evidence rather than assumption. If it passes, the tolerance is proven for these inputs and the
 * table is unnecessary. If it fails, the failure names exactly which ranges need vendoring.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  NFKC_HOLDBACK_CODE_POINTS,
  PINNED_UNICODE_VERSION,
  normalizeAndLowerPinned,
  normalizeNfkcPinned,
} from '../src/unicode-normalize.js'
import { isOtherCategory } from '../src/unicode-tables.js'

interface NfkcVector {
  readonly name: string
  readonly input: string
  readonly nfkc: string
  readonly nfkc_lower: string
  readonly nfkc_code_points: readonly number[]
  readonly categories: readonly string[]
}

interface NfkcVectorFile {
  readonly schema_version: number
  readonly unicode_version: string
  readonly vectors: readonly NfkcVector[]
}

const vectorFile = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../fixtures/runtime/unicode-nfkc-vectors.json'),
    'utf8',
  ),
) as NfkcVectorFile

test('the committed vectors were exported against the pinned Unicode version', () => {
  // If CPython moves, the vectors have to be re-exported and re-checked rather than trusted: they
  // are the record of one specific database's answers.
  assert.equal(vectorFile.unicode_version, PINNED_UNICODE_VERSION)
  assert.ok(vectorFile.vectors.length >= 30, 'the set must be broad enough to be evidence')
})

test('the host normalizer alone does NOT agree, which is why the pinned one exists', () => {
  // Recorded as a fact, not a wish. If a future ICU or CPython closes the gap this test fails and
  // the holdback can be deleted rather than carried forever.
  const divergent = vectorFile.vectors
    .filter(vector => vector.input.normalize('NFKC') !== vector.nfkc)
    .map(vector => vector.name)
    .sort()
  assert.deepEqual(
    divergent,
    ['unicode-16-outlined-digits', 'unicode-16-outlined-letters', 'unicode-16-symbols'],
    'the host/oracle normalization gap is the 16.0 code points that carry a decomposition',
  )
})

test('the host lowercase alone does not agree either, on a different set', () => {
  // A separate mechanism with the same root cause, and the reason the pipeline needs pinning at both
  // stages rather than only the first: these code points have a case mapping in ICU and none in the
  // pinned database, because it does not know they exist.
  const divergent = vectorFile.vectors
    .filter(vector => vector.input.normalize('NFKC').toLowerCase() !== vector.nfkc_lower)
    .map(vector => vector.name)
    .sort()
  assert.deepEqual(
    divergent,
    [
      'unicode-16-outlined-digits',
      'unicode-16-outlined-letters',
      'unicode-16-symbols',
      'unicode-16-uppercase-cyrillic',
      'unicode-16-uppercase-garay',
      'unicode-16-uppercase-latin',
    ],
    'the host/oracle casing gap is the 16.0 uppercase letters, plus the decomposition cases',
  )
})

test('the pinned NFKC agrees with CPython on every committed vector', () => {
  const divergent: string[] = []
  for (const vector of vectorFile.vectors) {
    const actual = normalizeNfkcPinned(vector.input)
    if (actual !== vector.nfkc) {
      divergent.push(
        `${vector.name}: python=${JSON.stringify(vector.nfkc)} `
          + `node=${JSON.stringify(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'these inputs normalize differently in the two runtimes')
})

test('a pair of newly-assigned code points cannot compose across the pin', () => {
  // The case that disproved an earlier, narrower holdback rule. U+16D63 and U+16D68 are both
  // unassigned at the pin and both unchanged by NFKC on their own, so a set derived from
  // single-character behavior did not include them -- yet ICU composes the pair into U+16D6A while
  // CPython returns it untouched. Holding back every code point the pin does not know is what fixes
  // this, and no narrower rule can.
  const pair = '\u{16d63}\u{16d68}'
  assert.equal(pair.normalize('NFKC'), '\u{16d6a}', 'the host still composes it')
  assert.equal(normalizeNfkcPinned(pair), pair, 'the pin leaves both characters alone')
  // Neither character is in the transformed list, which is exactly why the list cannot be the rule.
  assert.equal(NFKC_HOLDBACK_CODE_POINTS.includes(0x16d63), false)
  assert.equal(NFKC_HOLDBACK_CODE_POINTS.includes(0x16d68), false)
})

test('a newly-assigned uppercase letter is not lowercased', () => {
  // A separate mechanism: U+10D50 has no decomposition, so only the casing stage diverges.
  const capital = '\u{10d50}'
  assert.equal(capital.toLowerCase(), '\u{10d70}', 'the host still lowercases it')
  assert.equal(normalizeAndLowerPinned(capital), capital, 'the pin does not know it has a mapping')
})

test('the holdback set is every code point the pin calls unassigned and the host transforms', () => {
  // The set is derived at module load, so this re-derives it over the whole code space and both
  // transforms, with no block assumptions. A code point the pin has never heard of cannot decompose
  // or case-map there, so any host transform of one is a divergence.
  const shouldHold: number[] = []
  for (let codePoint = 0; codePoint <= 0x10_ff_ff; codePoint += 1) {
    if (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) continue
    if (!isOtherCategory(codePoint)) continue
    const character = String.fromCodePoint(codePoint)
    if (character.normalize('NFKC') !== character || character.toLowerCase() !== character) {
      shouldHold.push(codePoint)
    }
  }
  assert.deepEqual([...NFKC_HOLDBACK_CODE_POINTS], shouldHold)
  // Both mechanisms are represented: thirty-six decompose, twenty-seven only case-map.
  const decomposing = shouldHold.filter(codePoint => {
    const character = String.fromCodePoint(codePoint)
    return character.normalize('NFKC') !== character
  })
  assert.equal(decomposing.length, 36)
  assert.equal(shouldHold.length - decomposing.length, 27)
})

test('holding a code point back does not disturb its neighbours', () => {
  // Splitting the string is only sound because every held-back code point is unassigned in the
  // pinned database, so nothing composes across it there either. These cases put a held character
  // between things that *would* compose if the boundary were wrong.
  const held = '\u{1ccf0}'
  assert.equal(normalizeNfkcPinned(`ﬁ${held}café`), `fi${held}café`)
  assert.equal(normalizeNfkcPinned(`${held}\u0301`), `${held}\u0301`)
  assert.equal(normalizeNfkcPinned(`${held}${held}`), `${held}${held}`)
  // A base character, a held character, then a combining mark: the mark must not reach back past
  // the boundary and compose with the base.
  assert.equal(normalizeNfkcPinned(`A${held}\u0301`), `A${held}\u0301`)
  // Hangul jamo either side of a held character must not compose into a syllable.
  assert.equal(normalizeNfkcPinned(`\u1100${held}\u1161`), `\u1100${held}\u1161`)
  // And text with nothing to hold back must be byte-identical to the plain call.
  assert.equal(normalizeNfkcPinned('ＨＥＬＬＯ café'), 'ＨＥＬＬＯ café'.normalize('NFKC'))
})

test('a private-use code point in the input survives intact', () => {
  // An earlier implementation substituted held characters with private-use placeholders, which
  // silently corrupted any input that already contained one: `U+F0000 U+1CCF0` came back as
  // `U+1CCF0 U+1CCF0`. Private-use characters are legal text, so no code point is safe to borrow.
  const held = '\u{1ccf0}'
  const priv = '\u{f0000}'
  assert.equal(normalizeNfkcPinned(priv), priv)
  assert.equal(normalizeNfkcPinned(`${priv}${held}`), `${priv}${held}`)
  assert.equal(normalizeNfkcPinned(`${held}${priv}`), `${held}${priv}`)
  assert.equal(normalizeNfkcPinned(`${priv}${held}${priv}${held}`), `${priv}${held}${priv}${held}`)
})

test('adjacent unassigned code points never compose, across every small unassigned block', () => {
  // Pairs, not just singletons: contextual composition is the failure mode a per-code-point scan
  // cannot see. Blocks larger than 512 code points are the vast unassigned planes, where no ICU
  // composition exists to find, so the scan stays fast enough for the normal suite.
  let composed = 0
  let previousEnd = -2
  let blockStart = -1
  const checkBlock = (start: number, end: number): void => {
    if (start < 0 || end - start > 512) return
    const limit = Math.min(end, start + 40)
    for (let a = start; a <= limit; a += 1) {
      for (let b = start; b <= limit; b += 1) {
        const pair = String.fromCodePoint(a) + String.fromCodePoint(b)
        if (normalizeNfkcPinned(pair) !== pair) composed += 1
      }
    }
  }
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    const unassigned = !(codePoint >= 0xd800 && codePoint <= 0xdfff) && isOtherCategory(codePoint)
    if (unassigned) {
      if (codePoint !== previousEnd + 1) {
        checkBlock(blockStart, previousEnd)
        blockStart = codePoint
      }
      previousEnd = codePoint
    }
  }
  checkBlock(blockStart, previousEnd)
  assert.equal(composed, 0, 'the pin composes nothing it does not know, so neither may we')
})

test('every single code point runs both pipelines as the pinned database would', () => {
  // The claim this module rests on, checked exhaustively rather than sampled: over all 1,112,064
  // non-surrogate code points, both pinned pipelines produce what the pin would.
  let normalizeDisagreements = 0
  let lowerDisagreements = 0
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
    const character = String.fromCodePoint(codePoint)
    // A code point the pin does not know is left exactly alone by both transforms.
    if (isOtherCategory(codePoint)) {
      if (normalizeNfkcPinned(character) !== character) normalizeDisagreements += 1
      if (normalizeAndLowerPinned(character) !== character) lowerDisagreements += 1
      continue
    }
    if (normalizeNfkcPinned(character) !== character.normalize('NFKC')) {
      normalizeDisagreements += 1
    }
    if (normalizeAndLowerPinned(character) !== character.normalize('NFKC').toLowerCase()) {
      lowerDisagreements += 1
    }
  }
  assert.equal(normalizeDisagreements, 0)
  assert.equal(lowerDisagreements, 0)
})

test('the code points agree too, not only the string comparison', () => {
  // A string comparison could in principle pass on inputs that differ in composition; comparing
  // code points states what actually has to match.
  for (const vector of vectorFile.vectors) {
    assert.deepEqual(
      [...normalizeNfkcPinned(vector.input)].map(character => character.codePointAt(0)),
      [...vector.nfkc_code_points],
      vector.name,
    )
  }
})

test('the whole normalize-then-lowercase pipeline agrees, which is what recall runs', () => {
  // `recall.py` lowercases the normalized text before tokenizing. Python's full lowercase and
  // JavaScript's toLowerCase are not identical for every input, so the pipeline has to be pinned
  // rather than only its first stage.
  const divergent: string[] = []
  for (const vector of vectorFile.vectors) {
    const actual = normalizeAndLowerPinned(vector.input)
    if (actual !== vector.nfkc_lower) {
      divergent.push(
        `${vector.name}: python=${JSON.stringify(vector.nfkc_lower)} `
          + `node=${JSON.stringify(actual)}`,
      )
    }
  }
  assert.deepEqual(divergent, [], 'these inputs lowercase differently after normalization')
})

test('the vectors include code points where the two Unicode databases disagree', () => {
  // The whole point of the set: if it only contained characters both databases have known about
  // for years, agreement would prove nothing about version skew. These are assigned in 16.0 and
  // unassigned in 15.0.0, so CPython calls them Cn and ICU does not.
  const skewed = vectorFile.vectors.filter(vector => vector.name.startsWith('unicode-16-'))
  assert.ok(skewed.length >= 8, 'the set must exercise the version skew it exists to detect')
  for (const vector of skewed) {
    assert.ok(
      vector.categories.includes('Cn'),
      `${vector.name} should be unassigned to the pinned database`,
    )
  }
})
