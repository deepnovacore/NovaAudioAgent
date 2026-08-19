// GENERATED FILE -- do not edit by hand.
// Regenerate with: uv run python scripts/generate_unicode_tables.py
//
// Unicode general-category tables pinned to Unicode 15.0.0, the version CPython
// bundles and therefore the version every committed fixture was exported against. V8 resolves
// `\p{...}` against ICU's Unicode version instead, which is newer and classifies recently
// assigned code points differently, so these tables replace those escapes. See scripts/generate_unicode_tables.py.
//
// Ranges are encoded as `gapFromPreviousEnd.rangeLength` hex pairs, which keeps a table that covers
// most of the code space to a few lines of reviewable diff.

export const PINNED_UNICODE_VERSION = '15.0.0'

interface Ranges {
  readonly starts: Int32Array
  readonly ends: Int32Array
}

function decodeRanges(encoded: string): Ranges {
  const pairs = encoded.split(',')
  const starts = new Int32Array(pairs.length)
  const ends = new Int32Array(pairs.length)
  let previousEnd = -1
  pairs.forEach((pair, index) => {
    const separator = pair.indexOf('.')
    const start = previousEnd + 1 + Number.parseInt(pair.slice(0, separator), 16)
    const end = start + Number.parseInt(pair.slice(separator + 1), 16)
    starts[index] = start
    ends[index] = end
    previousEnd = end
  })
  return {starts, ends}
}

function contains(ranges: Ranges, codePoint: number): boolean {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new RangeError(`not a Unicode code point: ${codePoint}`)
  }
  let low = 0
  let high = ranges.starts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (codePoint < ranges.starts[middle]!) high = middle - 1
    else if (codePoint > ranges.ends[middle]!) low = middle + 1
    else return true
  }
  return false
}

// C*: Cc, Cf, Cs, Co, Cn.
// control, format, surrogate, private use, and unassigned -- the set `valid_progress_summary` rejects.
// 712 ranges covering 965096 code points.
const ENCODED_OTHER_CATEGORY_RANGES = ''
  + '0.1f,5f.20,d.0,2ca.1,6.3,7.0,1.0,14.0,18d.0,26.1,32.1,3.0,37.7,1b.3,6.10,16.0,c0.0,30.1,3b.1,65.'
  + 'd,3b.1,31.1,f.0,1c.1,1.0,b.4,1f.8,4a.0,a1.0,8.1,2.1,16.0,7.0,1.2,4.1,9.1,2.1,4.7,1.3,2.0,5.1,19.'
  + '1,3.0,6.3,2.1,16.0,7.0,2.0,2.0,2.1,1.0,5.3,2.1,3.2,1.6,4.0,1.6,11.9,3.0,9.0,3.0,16.0,7.0,2.0,5.1'
  + ',a.0,3.0,3.1,1.e,4.1,c.6,7.0,3.0,8.1,2.1,16.0,7.0,2.0,5.1,9.1,2.1,3.6,3.3,2.0,5.1,12.9,2.0,6.2,3'
  + '.0,4.2,2.0,1.0,2.2,2.2,3.2,c.3,5.2,3.0,4.1,1.5,1.d,15.4,d.0,3.0,17.0,10.1,9.0,3.0,4.6,2.0,3.1,1.'
  + '1,4.1,a.6,16.0,3.0,17.0,a.0,5.1,9.0,3.0,4.6,2.5,2.0,4.1,a.0,3.b,d.0,3.0,33.0,3.0,6.3,10.1,1a.0,3'
  + '.0,12.2,18.0,9.0,1.1,7.2,1.3,6.0,1.0,8.5,a.1,3.b,3a.3,1d.24,2.0,1.0,5.0,18.0,1.0,17.1,5.0,1.0,7.'
  + '0,a.1,4.1f,48.0,24.3,27.0,24.0,f.0,d.24,c6.0,1.4,1.1,179.0,4.1,7.0,1.0,4.1,29.0,4.1,21.0,4.1,7.0'
  + ',1.0,4.1,f.0,39.0,4.1,43.1,20.2,1a.5,56.1,6.1,29d.2,59.6,16.8,18.8,14.b,d.0,3.0,2.b,5e.1,a.5,a.5'
  + ',e.0,b.5,59.6,2b.4,46.9,1f.0,c.3,c.3,1.2,2a.1,5.a,2c.3,1a.5,b.2,3e.1,41.0,1d.1,b.5,a.5,e.1,1f.30'
  + ',4d.2,2f.0,74.7,3c.2,f.2,3c.6,2b.1,b.7,2b.4,216.1,6.1,26.1,6.1,8.0,1.0,1.0,1.0,1f.1,35.0,f.0,e.1'
  + ',6.0,13.1,3.0,9.0,b.4,1a.4,31.f,2.1,1b.0,d.2,21.e,21.e,8c.3,297.18,b.14,714.1,20.0,15d.4,2d.0,1.'
  + '4,1.1,38.6,2.d,18.8,7.0,7.0,7.0,7.0,7.0,7.0,7.0,7.0,7e.21,1a.0,59.b,d6.19,c.3,40.0,56.1,67.4,2b.'
  + '0,5e.0,54.b,2f.0,726d.2,37.8,15c.13,b8.7,cb.4,2.0,1.0,5.17,3b.2,a.5,38.7,46.7,c.5,74.a,1e.2,4e.0'
  + ',b.3,21.0,37.8,e.1,a.1,67.17,1c.9,6.1,6.1,6.8,7.0,7.0,3c.3,7e.1,a.5,2ba4.b,17.3,31.2103,16e.1,6a'
  + '.25,7.b,5.4,1a.0,5.0,1.0,2.0,2.0,7d.f,1bd.1,36.6,1.1f,2a.5,33.0,13.0,4.3,5.0,87.3,be.2,6.1,6.1,6'
  + '.1,3.2,7.0,7.c,2.1,c.0,1a.0,13.0,2.0,f.1,e.21,7b.4,3.3,2d.2,58.0,d.2,1.2e,2e.81,1d.2,31.e,1c.3,2'
  + '4.8,1e.4,2b.4,1e.0,25.3,e.29,9e.1,a.5,24.3,24.3,28.7,34.a,c.0,f.0,7.0,2.0,b.0,f.0,7.0,2.42,137.8'
  + ',16.9,8.17,6.0,2a.0,9.44,6.1,1.0,2c.0,2.2,1.1,17.0,48.7,9.2f,13.0,2.4,21.2,1b.4,1.3f,38.3,14.1,3'
  + '2.0,2.4,8.0,3.0,1d.1,3.3,a.6,9.6,40.1f,27.3,c.8,36.2,1d.1,1b.4,1a.6,4.b,7.4f,49.36,33.c,33.6,2e.'
  + '7,a.125,1f.0,2a.0,3.1,2.4a,2b.7,2a.15,1a.25,1c.13,17.8,4e.3,24.8,3e.0,5.c,19.6,a.5,35.0,12.7,27.'
  + '8,60.0,14.a,12.0,2f.3d,7.0,1.0,4.0,f.0,b.5,3b.4,a.5,4.0,8.1,2.1,16.0,7.0,2.0,5.0,a.1,2.1,3.1,1.5'
  + ',1.4,7.1,7.2,5.8a,5c.0,5.1d,48.7,a.a5,36.1,26.21,45.a,a.5,d.12,3a.5,a.35,1b.1,f.3,17.b8,3c.63,53'
  + '.b,8.1,1.1,8.0,2.0,1e.0,2.1,c.8,a.45,8.1,2e.1,b.1a,48.7,53.c,49.6,a.f5,9.0,2d.0,e.9,1d.2,20.1,16'
  + '.0,e.48,7.0,2.0,2c.2,1.0,2.0,9.7,a.5,6.0,2.0,25.0,2.0,6.6,a.135,19.6,11.0,29.2,1c.55,1.e,32.c,39'
  + 'b.65,6f.0,5.a,c4.a4b,63.c,430.f,16.fa9,247.21b8,239.6,1f.0,a.3,51.0,a.5,1e.1,6.9,46.9,a.0,7.0,15'
  + '.4,13.2af,5b.64,4b.3,39.6,11.3f,5.a,2.d,17f8.7,4d6.29,9.22e6,4.0,7.0,2.0,123.e,1.1c,3.1,1.d,4.7,'
  + '18c.903,6b.4,d.2,9.6,a.1,4.125f,2e.1,17.8,74.3b,f6.9,27.1,4a.7,70.14,46.79,14.b,14.b,57.8,19.86,'
  + '55.0,47.0,2.1,1.1,2.1,4.0,c.0,1.0,7.0,41.0,4.1,8.0,7.0,1c.0,4.0,5.0,1.2,7.0,154.1,124.1,2be.e,5.'
  + '0,f.44f,1f.5,6.d4,7.0,11.1,7.0,2.0,5.4,3e.20,1.6f,2d.2,e.1,a.3,2.13f,1f.10,3a.4,1.1cf,2a.2e5,7.0'
  + ',4.0,2.0,f.0,c5.1,10.28,4c.3,a.3,2.310,44.4b,3d.c1,4.0,1b.0,2.0,1.1,1.0,a.0,4.0,1.0,1.5,1.3,1.0,'
  + '1.0,1.0,3.0,2.0,1.1,1.0,1.0,1.0,1.0,1.0,2.0,1.1,4.0,7.0,4.0,4.0,1.0,a.0,11.4,3.0,5.0,11.33,2.10d'
  + ',2c.3,64.b,f.1,f.0,f.0,25.9,ae.37,1d.c,2c.3,9.6,2.d,6.99,3d8.3,11.2,d.2,77.3,5f.5,c.3,1.e,c.3,38'
  + '.7,a.5,28.7,1e.1,2.4d,154.b,e.1,d.2,9.6,2e.0,7.7,e.3,9.6,9.6,93.0,37.24,a.405,a6e0.1f,103a.5,de.'
  + '1,1682.d,1d31.c1e,21e.5e1,134b.4,1060.add4f,f0.2fe0f'

const C_RANGES = decodeRanges(ENCODED_OTHER_CATEGORY_RANGES)

export const OTHER_CATEGORY_RANGE_COUNT = C_RANGES.starts.length

/**
 * Whether one code point's Unicode 15.0.0 general category starts with C.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('C')` at the pinned
 * version, and deliberately NOT equivalent to `/\p{C}/u`, which tracks whatever
 * Unicode version the host ICU carries.
 */
export function isOtherCategory(codePoint: number): boolean {
  return contains(C_RANGES, codePoint)
}

/** Whether any character in the string is in a C category at the pinned version. */
export function hasOtherCategory(value: string): boolean {
  for (const character of value) {
    if (isOtherCategory(character.codePointAt(0)!)) return true
  }
  return false
}

// P*: Pc, Pd, Ps, Pe, Pi, Pf, Po.
// every kind of punctuation -- the set `realtime/project_confirmation.py` strips before matching a confirmation utterance.
// 191 ranges covering 842 code points.
const ENCODED_PUNCTUATION_CATEGORY_RANGES = ''
  + '21.2,1.5,1.3,a.1,3.1,1a.2,1.0,1b.0,1.0,23.0,5.0,3.0,a.1,3.0,3.0,2be.0,8.0,1d2.5,29.1,33.0,1.0,2.'
  + '0,2.0,2c.1,14.1,1.1,d.0,1.2,4a.3,66.0,2b.d,e9.2,36.e,1f.0,105.1,a.0,8c.0,78.0,79.0,186.0,c.0,16f'
  + '.0,5a.0,a.1,a8.e,1.0,25.3,47.0,4a.4,4.1,6f.5,ab.0,264.8,97.0,26d.0,2c.1,4e.2,47.1,9d.2,1.2,25.a,'
  + '139.1,d8.1,80.6,1.5,ac.6,1c.1,7d.3,3b.4,3e.1,40.7,b.0,33c.17,8.13,1.c,1.b,1e.1,e.1,279.3,1d.1,43'
  + 'd.d,4f.1,1f.9,193.15,3f.3,20.1,2fb.3,1.1,70.0,8f.2e,1.1f,2.b,1a3.2,4.9,2.b,10.0,c.0,62.0,5a.0,74'
  + '02.1,10d.2,63.0,a.0,73.5,17c.3,56.1,28.2,1.0,31.1,2f.0,61.c,10.1,7c.3,7e.1,10.1,f9.0,5152.1,d0.9'
  + ',16.22,1.d,1.0,4.0,1.1,95.2,1.5,1.3,a.1,3.1,1a.2,1.0,1b.0,1.0,1.6,19a.2,29c.0,30.0,19e.0,2e7.0,c'
  + '7.0,1f.0,110.8,26.0,70.6,42.6,59.3,310.0,a7.4,2c.3,bd.6,6d.1,1.3,7e.3,30.1,4f.3,4.0,d.0,1.2,58.5'
  + ',6b.0,1a1.4,a.1,1.0,68.0,fa.16,69.2,1c.c,4c.0,82.2,fc.0,108.2,9b.0,5c.7,53.2,1.4,5d.9,137.4,2a.1'
  + ',285.1,4a.c,af.0,470.4,b7c.1,3a7b.1,85.0,41.4,8.0,352.3,147.0,4cbc.0,1de7.4,ed2.1'

const P_RANGES = decodeRanges(ENCODED_PUNCTUATION_CATEGORY_RANGES)

export const PUNCTUATION_CATEGORY_RANGE_COUNT = P_RANGES.starts.length

/**
 * Whether one code point's Unicode 15.0.0 general category starts with P.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('P')` at the pinned
 * version, and deliberately NOT equivalent to `/\p{P}/u`, which tracks whatever
 * Unicode version the host ICU carries.
 */
export function isPunctuationCategory(codePoint: number): boolean {
  return contains(P_RANGES, codePoint)
}

/** Whether any character in the string is in a P category at the pinned version. */
export function hasPunctuationCategory(value: string): boolean {
  for (const character of value) {
    if (isPunctuationCategory(character.codePointAt(0)!)) return true
  }
  return false
}
