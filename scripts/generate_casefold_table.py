"""Generate the TypeScript exceptions for CPython-compatible Unicode casefolding.

The ordinary one-code-point lowercase mappings live in ``unicode-normalize.ts``. This file emits
only mappings for which CPython's full ``str.casefold()`` differs from ``str.lower()``.

    uv run python scripts/generate_casefold_table.py --check
    uv run python scripts/generate_casefold_table.py --export
"""

from __future__ import annotations

import argparse
import sys
import unicodedata
from pathlib import Path

GENERATOR = "scripts/generate_casefold_table.py"
PINNED_UNICODE_VERSION = "15.0.0"
TARGET = Path(__file__).resolve().parents[1] / "runtime" / "src" / "unicode-casefold.ts"


def encoded_exceptions() -> str:
    """Return sorted ``source:folded`` hex mappings for every well-formed scalar."""
    entries: list[str] = []
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        character = chr(code_point)
        folded = character.casefold()
        if folded == character.lower():
            continue
        encoded = ",".join(f"{ord(value):x}" for value in folded)
        entries.append(f"{code_point:x}:{encoded}")
    return ";".join(entries)


def render() -> str:
    encoded = encoded_exceptions()
    return f"""// GENERATED FILE -- do not edit by hand.
// Regenerate with: uv run python {GENERATOR} --export

import {{toLowerPinned}} from './unicode-normalize.js'

/*
 * Unicode {PINNED_UNICODE_VERSION} full-casefold mappings whose result differs from lowercase.
 * Generated from the same CPython Unicode database as the project fixtures. Ordinary mappings use
 * the already-pinned per-code-point lowercase helper; processing one scalar at a time deliberately
 * avoids JavaScript's contextual final-sigma lowercasing.
 */
const CASEFOLD_EXCEPTIONS = '{encoded}'

const exceptionMap: ReadonlyMap<number, string> = new Map(
  CASEFOLD_EXCEPTIONS.split(';').map(entry => {{
    const [source, folded] = entry.split(':') as [string, string]
    return [
      Number.parseInt(source, 16),
      String.fromCodePoint(...folded.split(',').map(value => Number.parseInt(value, 16))),
    ] as const
  }}),
)

/** CPython `str.casefold()` pinned to Unicode {PINNED_UNICODE_VERSION} for well-formed scalar text. */
export function casefoldLikePython(text: string): string {{
  let result = ''
  for (const character of text) {{
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) continue
    result += exceptionMap.get(codePoint) ?? toLowerPinned(character)
  }}
  return result
}}
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--export", action="store_true")
    args = parser.parse_args(argv)
    if unicodedata.unidata_version != PINNED_UNICODE_VERSION:
        print(
            "casefold generation requires Unicode "
            f"{PINNED_UNICODE_VERSION}, got {unicodedata.unidata_version}",
            file=sys.stderr,
        )
        return 2
    expected = render()
    if args.check:
        if TARGET.read_text(encoding="utf-8") != expected:
            print(f"stale generated file: {TARGET}", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(expected, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(Path.cwd())} at Unicode {PINNED_UNICODE_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
