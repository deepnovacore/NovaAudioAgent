"""Generate the Node runtime's pinned Unicode general-category tables.

Python classifies characters with the Unicode database bundled into CPython, and
V8 classifies them with the Unicode database bundled into ICU. Those versions are
not the same and drift with every release, so ``unicodedata.category(c)`` and
``/\\p{C}/u`` disagree about any code point assigned between them. CPython 3.12
carries Unicode 15.0.0; Node 24 with ICU 77 carries Unicode 16.0. U+1CC00,
U+1E5D0, and U+10D40 are ``Cn`` (unassigned) to Python and assigned symbols to
Node, so a progress summary containing one is dropped by Python and recorded by
Node.

Committed fixtures are the permanent oracle for this migration, so a predicate
that reads either runtime's ambient Unicode tables makes those fixtures fragile
against an ICU or CPython upgrade. This script emits the ranges once, from the
version Python currently pins, into a generated TypeScript module the Node
runtime consults instead of a ``\\p{...}`` escape.

Run from the repository root:

    uv run python scripts/generate_unicode_tables.py

``tests/test_unicode_tables.py`` fails if CPython's Unicode version stops matching
the pinned one, so an interpreter upgrade becomes an explicit decision rather than
a silent behavior change.
"""

from __future__ import annotations

import subprocess
import sys
import unicodedata
from pathlib import Path

PINNED_UNICODE_VERSION = "15.0.0"

TARGET = Path("runtime/src/unicode-tables.ts")
GENERATOR = "scripts/generate_unicode_tables.py"


def other_category_ranges() -> list[tuple[int, int]]:
    """Inclusive code-point ranges whose general category starts with ``C``.

    That is Cc, Cf, Cs, Co, and Cn: control, format, surrogate, private use, and
    unassigned. It is the set Python's ``valid_progress_summary`` rejects.
    """
    ranges: list[tuple[int, int]] = []
    start: int | None = None
    for code_point in range(0x110000):
        is_other = unicodedata.category(chr(code_point)).startswith("C")
        if is_other and start is None:
            start = code_point
        elif not is_other and start is not None:
            ranges.append((start, code_point - 1))
            start = None
    if start is not None:
        ranges.append((start, 0x10FFFF))
    return ranges


def encode(ranges: list[tuple[int, int]]) -> str:
    """Encode as base-36 delta pairs so the payload stays small and format-stable.

    A TypeScript array literal of 712 ranges would be reflowed by any formatter
    change and would make the drift diff unreadable. One string of
    ``gap.length`` pairs is stable, and the runtime expands it once at module load.
    """
    parts: list[str] = []
    previous_end = -1
    for start, end in ranges:
        parts.append(f"{start - previous_end - 1:x}.{end - start:x}")
        previous_end = end
    return ",".join(parts)


def render(ranges: list[tuple[int, int]]) -> str:
    encoded = encode(ranges)
    lines = [encoded[index : index + 96] for index in range(0, len(encoded), 96)]
    body = "\n".join(f"  + '{line}'" for line in lines)
    covered = sum(end - start + 1 for start, end in ranges)
    return f"""// GENERATED FILE -- do not edit by hand.
// Regenerate with: uv run python {GENERATOR}
//
// Unicode general categories starting with C (Cc, Cf, Cs, Co, Cn) pinned to
// Unicode {PINNED_UNICODE_VERSION}, the version CPython bundles and therefore the version every
// committed fixture was exported against. V8 resolves /\\p{{C}}/u against ICU's
// Unicode version instead, which is newer and classifies recently assigned code
// points differently, so this table replaces that escape. See {GENERATOR}.
//
// {len(ranges)} ranges covering {covered} code points, encoded as base-36-free
// hex `gapFromPreviousEnd.rangeLength` pairs.

export const PINNED_UNICODE_VERSION = '{PINNED_UNICODE_VERSION}'

const ENCODED_OTHER_CATEGORY_RANGES = ''
{body}

function decodeRanges(encoded: string): {{starts: Int32Array, ends: Int32Array}} {{
  const pairs = encoded.split(',')
  const starts = new Int32Array(pairs.length)
  const ends = new Int32Array(pairs.length)
  let previousEnd = -1
  pairs.forEach((pair, index) => {{
    const separator = pair.indexOf('.')
    const start = previousEnd + 1 + Number.parseInt(pair.slice(0, separator), 16)
    const end = start + Number.parseInt(pair.slice(separator + 1), 16)
    starts[index] = start
    ends[index] = end
    previousEnd = end
  }})
  return {{starts, ends}}
}}

const {{starts: RANGE_STARTS, ends: RANGE_ENDS}} = decodeRanges(ENCODED_OTHER_CATEGORY_RANGES)

export const OTHER_CATEGORY_RANGE_COUNT = RANGE_STARTS.length

/**
 * Whether one code point's Unicode {PINNED_UNICODE_VERSION} general category starts with C.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('C')` at the
 * pinned version, and deliberately NOT equivalent to `/\\p{{C}}/u`, which tracks
 * whatever Unicode version the host ICU carries.
 */
export function isOtherCategory(codePoint: number): boolean {{
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {{
    throw new RangeError(`not a Unicode code point: ${{codePoint}}`)
  }}
  let low = 0
  let high = RANGE_STARTS.length - 1
  while (low <= high) {{
    const middle = (low + high) >> 1
    if (codePoint < RANGE_STARTS[middle]!) high = middle - 1
    else if (codePoint > RANGE_ENDS[middle]!) low = middle + 1
    else return true
  }}
  return false
}}

/** Whether any character in the string is in a C category at the pinned version. */
export function hasOtherCategory(value: string): boolean {{
  for (const character of value) {{
    if (isOtherCategory(character.codePointAt(0)!)) return true
  }}
  return false
}}
"""


def main() -> int:
    if unicodedata.unidata_version != PINNED_UNICODE_VERSION:
        print(
            f"refusing to generate: this interpreter carries Unicode "
            f"{unicodedata.unidata_version}, not the pinned {PINNED_UNICODE_VERSION}. "
            f"Changing the pin changes what every committed fixture means, so make "
            f"that an explicit decision.",
            file=sys.stderr,
        )
        return 1
    ranges = other_category_ranges()
    target = Path(TARGET)
    target.write_text(render(ranges), encoding="utf-8")
    print(f"wrote {target} with {len(ranges)} ranges at Unicode {PINNED_UNICODE_VERSION}")
    subprocess.run(["npx", "eslint", "--fix", "src/unicode-tables.ts"], cwd="runtime", check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
