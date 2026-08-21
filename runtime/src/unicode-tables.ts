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

// L*: Lu, Ll, Lt, Lm, Lo.
// every kind of letter -- one half of Python `str.isalnum()` used by project slugs.
// 659 ranges covering 136104 code points.
const ENCODED_LETTER_CATEGORY_RANGES = ''
  + '41.19,6.19,2f.0,a.0,4.0,5.16,1.1e,1.1c9,4.b,e.4,7.0,1.0,81.4,1.1,2.3,1.0,6.0,1.2,1.0,1.13,1.52,1'
  + '.8a,8.a5,1.25,2.0,6.28,47.1a,4.3,2d.2a,23.1,1.62,1.0,f.1,7.1,a.2,2.0,10.0,1.1d,1d.58,b.0,18.20,9'
  + '.1,4.0,5.15,4.0,9.0,3.0,17.18,7.a,5.17,1.5,11.29,3a.35,3.0,12.0,7.9,f.f,4.7,2.1,2.15,1.6,1.0,3.3'
  + ',3.0,10.0,d.1,1.2,e.1,a.0,8.5,4.1,2.15,1.6,1.1,1.1,1.1,1f.3,1.0,13.2,10.8,1.2,1.15,1.6,1.1,1.4,3'
  + '.0,12.0,f.1,17.0,b.7,2.1,2.15,1.6,1.1,1.4,3.0,1e.1,1.2,f.0,11.0,1.5,3.2,1.3,3.1,1.0,1.1,3.1,3.2,'
  + '3.b,16.0,34.7,1.2,1.16,1.f,3.0,1a.2,2.0,2.1,1e.0,4.7,1.2,1.16,1.9,1.4,3.0,1f.1,1.1,f.1,11.8,1.2,'
  + '1.28,2.0,10.0,5.2,8.2,18.5,5.11,3.17,1.8,1.0,2.6,3a.2f,1.1,c.6,3a.1,1.0,1.4,1.17,1.0,1.9,1.1,9.0'
  + ',2.4,1.0,15.3,20.0,3f.7,1.23,1b.4,73.2a,14.0,10.5,4.3,3.0,3.1,7.2,4.c,c.0,11.25,1.0,5.0,2.2a,1.1'
  + '4c,1.3,2.6,1.0,1.3,2.28,1.3,2.20,1.3,2.6,1.0,1.3,2.e,1.38,1.3,2.42,25.f,10.55,2.5,3.26b,2.10,1.1'
  + '9,5.4a,6.7,7.11,d.12,e.11,e.c,1.2,f.33,23.0,4.0,43.58,7.4,2.21,1.0,5.45,a.1e,31.1d,2.4,b.2b,4.19'
  + ',36.16,9.34,52.0,5d.2e,11.7,36.1d,d.1,a.2b,1a.23,29.2,a.23,2.8,7.2a,2.2,29.3,1.5,1.1,3.0,5.bf,40'
  + '.115,2.5,2.25,2.5,2.7,1.0,1.0,1.0,1.1e,2.34,1.6,1.0,3.2,1.6,3.3,2.5,4.c,5.2,1.6,74.0,d.0,10.c,65'
  + '.0,4.0,2.9,1.0,3.4,6.0,1.0,1.0,1.3,1.a,2.3,5.4,4.0,34.1,a7b.e4,6.3,3.1,c.25,1.0,5.0,2.37,7.0,10.'
  + '16,9.6,1.6,1.6,1.6,1.6,1.6,1.6,1.6,50.0,1d5.1,2a.4,5.1,4.55,6.2,1.59,1.3,5.2a,1.5d,11.1f,30.f,20'
  + '0.19bf,40.568c,43.2d,2.10c,3.f,a.1,14.2e,10.1e,2.45,31.8,2.66,2.3f,5.1,1.0,1.4,18.f,1.2,1.3,1.16'
  + ',1d.33,e.31,3e.5,3.0,1.1,b.1b,a.16,19.1c,7.2e,1c.0,10.4,1.9,a.4,1.28,17.2,1.7,14.16,3.0,3.31,1.0'
  + ',3.1,2.4,2.0,1.0,18.2,2.a,7.2,c.5,2.5,2.5,9.6,1.6,1.2a,1.d,6.72,1d.2ba3,c.16,4.30,2104.16d,2.69,'
  + '26.6,c.4,5.0,1.9,1.c,1.4,1.0,1.1,1.1,1.6b,21.16a,12.3f,2.35,28.b,74.4,1.86,24.19,6.19,b.58,3.5,2'
  + '.5,2.5,2.2,23.b,1.19,1.12,1.1,1.e,2.d,22.7a,185.1c,3.30,2f.1f,d.13,1.7,6.25,a.1d,2.23,4.7,30.9d,'
  + '12.23,4.23,4.27,8.33,c.a,1.e,1.6,1.1,1.a,1.e,1.6,1.1,43.136,9.15,a.7,18.5,1.29,1.8,45.5,2.0,1.2b'
  + ',1.1,3.0,2.16,a.16,9.1e,41.12,1.1,a.15,a.19,46.37,6.1,40.0,f.3,1.2,1.1c,2a.1c,3.1c,23.7,1.1b,1b.'
  + '35,a.15,a.12,d.11,6e.48,37.32,d.32,d.23,15c.29,6.1,4e.1c,a.0,8.15,2a.11,2e.14,1b.16,c.34,39.1,2.'
  + '0,d.2c,20.18,1a.23,1d.0,2.0,8.22,3.0,c.2f,e.3,15.0,1.0,23.11,1.18,13.1,3f.6,1.0,1.3,1.e,1.9,7.2e'
  + ',26.7,2.1,2.15,1.6,1.1,1.4,3.0,12.0,c.4,9e.34,12.3,14.2,1e.2f,14.1,1.0,b8.2e,29.3,24.2f,14.0,3b.'
  + '2a,d.0,47.1a,25.6,b9.2b,74.3f,1f.7,2.0,2.7,1.1,1.17,f.0,1.0,5e.7,2.26,10.0,1.0,1c.0,a.27,7.0,15.'
  + '0,b.2d,13.0,12.48,107.8,1.24,11.0,31.1d,70.6,1.1,1.25,15.0,19.5,1.1,1.1f,e.0,147.12,f.0,1.c,1.21'
  + ',7c.0,4f.399,e6.c3,a4c.60,f.42f,11.5,fb9.246,21b9.238,7.1e,11.4e,11.1d,12.2f,10.3,1f.14,5.12,2b0'
  + '.3f,80.4a,5.0,42.c,40.1,1.0,1c.17f7,8.4d5,2a.8,22e7.3,1.6,1.1,1.122,f.0,1d.2,2.0,e.3,8.18b,904.6'
  + 'a,5.c,3.8,7.9,1766.54,1.46,1.1,2.0,2.1,2.3,1.b,1.0,1.6,1.40,1.3,2.7,1.6,1.1b,1.3,1.4,1.0,3.6,1.1'
  + '53,2.18,1.18,1.1e,1.18,1.1e,1.18,1.1e,1.18,1.1e,1.18,1.7,734.1e,6.5,105.3d,92.2c,a.6,10.0,141.1d'
  + ',12.2b,1e4.1b,2f4.6,1.3,1.1,1.e,1.c4,3b.43,7.0,4b4.3,1.1a,1.1,1.0,2.0,1.9,1.3,1.0,1.0,6.0,4.0,1.'
  + '0,1.0,1.2,1.1,1.0,2.0,1.0,1.0,1.0,1.0,1.1,1.0,2.3,1.6,1.3,1.3,1.0,1.9,1.10,5.2,1.4,1.10,1144.a6d'
  + 'f,20.1039,6.dd,2.1681,e.1d30,c1f.21d,5e2.134a,5.105f'

const L_RANGES = decodeRanges(ENCODED_LETTER_CATEGORY_RANGES)

export const LETTER_CATEGORY_RANGE_COUNT = L_RANGES.starts.length

/**
 * Whether one code point's Unicode 15.0.0 general category starts with L.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('L')` at the pinned
 * version, and deliberately NOT equivalent to `/\p{L}/u`, which tracks whatever
 * Unicode version the host ICU carries.
 */
export function isLetterCategory(codePoint: number): boolean {
  return contains(L_RANGES, codePoint)
}

/** Whether any character in the string is in a L category at the pinned version. */
export function hasLetterCategory(value: string): boolean {
  for (const character of value) {
    if (isLetterCategory(character.codePointAt(0)!)) return true
  }
  return false
}

// N*: Nd, Nl, No.
// every kind of number -- one half of Python `str.isalnum()` used by project slugs.
// 137 ranges covering 1831 code points.
const ENCODED_NUMBER_CATEGORY_RANGES = ''
  + '30.9,78.1,5.0,2.2,5a1.9,86.9,c6.9,19c.9,76.9,4.5,6c.9,76.9,76.9,2.5,6e.c,73.9,8.6,67.9,68.6,7.12'
  + ',6d.9,60.9,76.9,46.13,10c.9,46.9,2cf.13,371.2,ef.9,6.9,16.9,12c.9,80.a,a5.9,6.9,b6.9,56.9,86.9,6'
  + '.9,416.0,3.5,6.9,c6.32,2.4,2d6.3b,4e.15,276.1d,569.0,309.0,19.8,e.2,157.3,8a.9,1e.7,1.e,20.9,27.'
  + 'e,7360.9,bc.9,140.5,9a.9,26.9,c6.9,16.9,56.9,196.9,5316.9,1ed.2c,c.38,11.1,155.1a,24.3,1d.0,8.0,'
  + '86.4,ca.9,3ae.7,19.6,27.8,4b.4,16.5,a0.1,2.f,2.2d,40.8,34.1,1e.2,4b.4,68.7,18.7,29.6,14a.5,30.9,'
  + '126.1e,9e.9,2a.3,70.6,86.1d,80.9,3c.9,90.9,7.13,fb.9,156.9,76.9,176.9,66.9,66.b,1a4.12,5d.9,2f6.'
  + '1c,e3.9,46.9,1a6.9,66.14,42b.6e,45f1.9,56.9,86.9,1.6,31e.16,6429.13,c.13,6c.18,455.31,940.9,1a6.'
  + '9,1f6.9,3cd.8,80.9,317.3a,1.2,1.3,4c.2c,1.e,3c2.c,ae3.9'

const N_RANGES = decodeRanges(ENCODED_NUMBER_CATEGORY_RANGES)

export const NUMBER_CATEGORY_RANGE_COUNT = N_RANGES.starts.length

/**
 * Whether one code point's Unicode 15.0.0 general category starts with N.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('N')` at the pinned
 * version, and deliberately NOT equivalent to `/\p{N}/u`, which tracks whatever
 * Unicode version the host ICU carries.
 */
export function isNumberCategory(codePoint: number): boolean {
  return contains(N_RANGES, codePoint)
}

/** Whether any character in the string is in a N category at the pinned version. */
export function hasNumberCategory(value: string): boolean {
  for (const character of value) {
    if (isNumberCategory(character.codePointAt(0)!)) return true
  }
  return false
}
