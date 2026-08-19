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
  // Recorded as a fact, not a wish. The measurement that produced it is the reason
  // `normalizeNfkcPinned` exists at all, and if a future ICU or CPython closes the gap this test
  // fails and the holdback can be deleted rather than carried forever.
  const divergent = vectorFile.vectors
    .filter(vector => vector.input.normalize('NFKC') !== vector.nfkc)
    .map(vector => vector.name)
    .sort()
  assert.deepEqual(
    divergent,
    ['unicode-16-outlined-digits', 'unicode-16-outlined-letters', 'unicode-16-symbols'],
    'the host/oracle gap is exactly the Unicode 16.0 code points that carry a decomposition',
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

test('the holdback set is exactly the code points the host decomposes and the oracle does not', () => {
  // Derived rather than trusted: scan the blocks Unicode 16.0 added and compare each code point's
  // host decomposition against the pinned database's verdict, which for anything it has not heard of
  // is to leave the character alone. A drift in either direction fails here.
  const shouldHold: number[] = []
  for (let codePoint = 0x1_cc_00; codePoint <= 0x1_ce_b3; codePoint += 1) {
    const character = String.fromCodePoint(codePoint)
    if (character.normalize('NFKC') !== character) shouldHold.push(codePoint)
  }
  assert.deepEqual(
    [...NFKC_HOLDBACK_CODE_POINTS],
    shouldHold,
    'the holdback list and the host ICU disagree about which code points decompose',
  )
})

test('holding a code point back does not disturb its neighbours', () => {
  // Substitution has to be transparent. A held-back character sits between a decomposable one and a
  // combining mark here, so a placeholder that merged with either side would show up.
  const held = '\u{1ccf0}'
  assert.equal(normalizeNfkcPinned(`ﬁ${held}café`), `fi${held}café`)
  assert.equal(normalizeNfkcPinned(`${held}\u0301`), `${held}\u0301`)
  assert.equal(normalizeNfkcPinned(`${held}${held}`), `${held}${held}`)
  // And text with nothing to hold back must be byte-identical to the plain call.
  assert.equal(normalizeNfkcPinned('ＨＥＬＬＯ café'), 'ＨＥＬＬＯ café'.normalize('NFKC'))
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
  assert.ok(skewed.length >= 5, 'the set must exercise the version skew it exists to detect')
  for (const vector of skewed) {
    assert.ok(
      vector.categories.includes('Cn'),
      `${vector.name} should be unassigned to the pinned database`,
    )
  }
})
