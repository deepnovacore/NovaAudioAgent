"""Emit Unicode general-category tables pinned to the version CPython bundles.

Python classifies characters with the database compiled into CPython; V8 resolves `\\p{...}`
against the one compiled into ICU. Those versions differ and drift with every release, so any
predicate that reads a runtime's ambient tables makes the committed fixtures fragile against an
interpreter or ICU upgrade. These tables replace those escapes.

Each category prefix gets its own table. Adding one means adding an entry to ``TABLES`` and nothing
else; the encoding, the lookup, and the drift tests are shared.

    uv run python scripts/generate_unicode_tables.py
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from pathlib import Path

GENERATOR = "scripts/generate_unicode_tables.py"
PINNED_UNICODE_VERSION = unicodedata.unidata_version
TARGET = Path(__file__).resolve().parents[1] / "runtime" / "src" / "unicode-tables.ts"


@dataclass(frozen=True, slots=True)
class Table:
    """One category prefix, and the names its lookup functions get."""

    prefix: str
    constant: str
    count_export: str
    code_point_predicate: str
    string_predicate: str
    categories: str
    purpose: str


TABLES: tuple[Table, ...] = (
    Table(
        prefix="C",
        constant="ENCODED_OTHER_CATEGORY_RANGES",
        count_export="OTHER_CATEGORY_RANGE_COUNT",
        code_point_predicate="isOtherCategory",
        string_predicate="hasOtherCategory",
        categories="Cc, Cf, Cs, Co, Cn",
        purpose="control, format, surrogate, private use, and unassigned -- the set "
        "`valid_progress_summary` rejects",
    ),
    Table(
        prefix="P",
        constant="ENCODED_PUNCTUATION_CATEGORY_RANGES",
        count_export="PUNCTUATION_CATEGORY_RANGE_COUNT",
        code_point_predicate="isPunctuationCategory",
        string_predicate="hasPunctuationCategory",
        categories="Pc, Pd, Ps, Pe, Pi, Pf, Po",
        purpose="every kind of punctuation -- the set `realtime/project_confirmation.py` strips "
        "before matching a confirmation utterance",
    ),
)


def category_ranges(prefix: str) -> list[tuple[int, int]]:
    """Inclusive code-point ranges whose general category starts with ``prefix``."""
    ranges: list[tuple[int, int]] = []
    start: int | None = None
    for code_point in range(0x110000):
        matches = unicodedata.category(chr(code_point)).startswith(prefix)
        if matches and start is None:
            start = code_point
        elif not matches and start is not None:
            ranges.append((start, code_point - 1))
            start = None
    if start is not None:
        ranges.append((start, 0x10FFFF))
    return ranges


def encode(ranges: list[tuple[int, int]]) -> str:
    """Encode as `gapFromPreviousEnd.rangeLength` hex pairs, which keeps the file reviewable."""
    parts: list[str] = []
    previous_end = -1
    for start, end in ranges:
        parts.append(f"{start - previous_end - 1:x}.{end - start:x}")
        previous_end = end
    return ",".join(parts)


def render_table(table: Table, ranges: list[tuple[int, int]]) -> str:
    encoded = encode(ranges)
    lines = [encoded[index : index + 96] for index in range(0, len(encoded), 96)]
    body = "\n".join(f"  + '{line}'" for line in lines)
    covered = sum(end - start + 1 for start, end in ranges)
    return f"""
// {table.prefix}*: {table.categories}.
// {table.purpose}.
// {len(ranges)} ranges covering {covered} code points.
const {table.constant} = ''
{body}

const {table.prefix}_RANGES = decodeRanges({table.constant})

export const {table.count_export} = {table.prefix}_RANGES.starts.length

/**
 * Whether one code point's Unicode {PINNED_UNICODE_VERSION} general category starts with \
{table.prefix}.
 *
 * Equivalent to Python `unicodedata.category(chr(cp)).startswith('{table.prefix}')` at the pinned
 * version, and deliberately NOT equivalent to `/\\p{{{table.prefix}}}/u`, which tracks whatever
 * Unicode version the host ICU carries.
 */
export function {table.code_point_predicate}(codePoint: number): boolean {{
  return contains({table.prefix}_RANGES, codePoint)
}}

/** Whether any character in the string is in a {table.prefix} category at the pinned version. */
export function {table.string_predicate}(value: string): boolean {{
  for (const character of value) {{
    if ({table.code_point_predicate}(character.codePointAt(0)!)) return true
  }}
  return false
}}
"""


def render(tables: tuple[tuple[Table, list[tuple[int, int]]], ...]) -> str:
    header = f"""// GENERATED FILE -- do not edit by hand.
// Regenerate with: uv run python {GENERATOR}
//
// Unicode general-category tables pinned to Unicode {PINNED_UNICODE_VERSION}, the version CPython
// bundles and therefore the version every committed fixture was exported against. V8 resolves
// `\\p{{...}}` against ICU's Unicode version instead, which is newer and classifies recently
// assigned code points differently, so these tables replace those escapes. See {GENERATOR}.
//
// Ranges are encoded as `gapFromPreviousEnd.rangeLength` hex pairs, which keeps a table that covers
// most of the code space to a few lines of reviewable diff.

export const PINNED_UNICODE_VERSION = '{PINNED_UNICODE_VERSION}'

interface Ranges {{
  readonly starts: Int32Array
  readonly ends: Int32Array
}}

function decodeRanges(encoded: string): Ranges {{
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

function contains(ranges: Ranges, codePoint: number): boolean {{
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {{
    throw new RangeError(`not a Unicode code point: ${{codePoint}}`)
  }}
  let low = 0
  let high = ranges.starts.length - 1
  while (low <= high) {{
    const middle = (low + high) >> 1
    if (codePoint < ranges.starts[middle]!) high = middle - 1
    else if (codePoint > ranges.ends[middle]!) low = middle + 1
    else return true
  }}
  return false
}}
"""
    return header + "".join(render_table(table, ranges) for table, ranges in tables)


def main() -> int:
    tables = tuple((table, category_ranges(table.prefix)) for table in TABLES)
    TARGET.write_text(render(tables), encoding="utf-8")
    for table, ranges in tables:
        covered = sum(end - start + 1 for start, end in ranges)
        print(f"{table.prefix}*: {len(ranges)} ranges, {covered} code points")
    print(f"wrote {TARGET.relative_to(Path.cwd())} at Unicode {PINNED_UNICODE_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
