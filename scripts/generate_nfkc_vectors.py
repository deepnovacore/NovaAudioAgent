"""Export NFKC conformance vectors so Node's normalization can be proven, not assumed.

Python normalizes with the Unicode database bundled into CPython; V8 normalizes with the one
bundled into ICU. Those versions differ, and `realtime/recall.py` runs the result through
lexical scoring, so a divergence changes which memories a model is shown. Vendoring a
normalization table is the fallback; this script establishes whether it is needed.

Two decisions are baked in. The vectors pin the whole `NFKC -> casefold-equivalent` pipeline
rather than NFKC alone, because `recall.py` applies `str.lower()` to the result and Python's
full lowercase and JavaScript's `toLowerCase` are not identical for every input. And the set
includes code points assigned only in Unicode 16.0, which are `Cn` to CPython 15.0.0 -- those
are where a version skew would surface first.

    uv run python scripts/generate_nfkc_vectors.py --export
    uv run python scripts/generate_nfkc_vectors.py check
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from collections.abc import Sequence
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
VECTORS_PATH = REPOSITORY_ROOT / "fixtures" / "runtime" / "unicode-nfkc-vectors.json"

# Inputs chosen so each one isolates a mechanism rather than merely being unusual.
CASES: tuple[tuple[str, str], ...] = (
    ("ascii-unchanged", "hello world 42"),
    ("ascii-uppercase", "HELLO World"),
    # Fullwidth forms are the compatibility decomposition recall depends on most: a query typed
    # with a fullwidth keyboard has to match memory written with a halfwidth one.
    ("fullwidth-latin", "ＨＥＬＬＯ　ｗｏｒｌｄ"),
    ("fullwidth-digits", "０１２３４５６７８９"),
    ("halfwidth-katakana", "ﾆﾎﾝｺﾞ"),
    ("fullwidth-punctuation", "（）［］｛｝！？"),
    # CJK compatibility ideographs decompose to their unified forms.
    ("cjk-compatibility", "豈更車賈滑"),
    ("cjk-unified-unchanged", "编译测试运行"),
    # Hangul composes and decomposes by algorithm rather than by table.
    ("hangul-jamo", "각"),
    ("hangul-syllable", "각"),
    # Circled and squared forms expand to several characters, so a length-based bound moves.
    ("circled-latin", "ⒶⒷⒸ"),
    ("circled-digits", "①②③"),
    ("squared-latin", "㍱㍲"),
    ("roman-numerals", "ⅠⅡⅢ"),
    # Ligatures and superscripts, which change character count under NFKC.
    ("ligature-fi", "ﬁne"),
    ("superscripts", "x² + y³"),
    ("fraction", "½ ⅓"),
    # Combining marks: the same grapheme composed and decomposed must normalize alike.
    ("combining-composed", "café"),
    ("combining-decomposed", "café"),
    ("combining-multiple", "q̣̇"),
    # Case mapping where Python's full lowercase and JavaScript's toLowerCase can disagree.
    ("turkish-dotted-i", "İstanbul"),
    ("german-sharp-s", "STRASSE ẞ ß"),
    ("greek-final-sigma", "ΟΔΟΣ ΟΔΌΣ"),
    ("cherokee-uppercase", "ᎠᎡᎢ"),
    ("deseret", "\U00010400\U00010401"),
    # Version skew: assigned in Unicode 16.0, unassigned (Cn) to CPython 15.0.0. Measured on the
    # development machine as the exact code points where the two databases disagree.
    ("unicode-16-garay", "\U0001e5d0"),
    ("unicode-16-gurung", "\U00016100"),
    ("unicode-16-sunuwar", "\U00011bc0"),
    ("unicode-16-todhri", "\U000105c0"),
    ("unicode-16-tulu-tigalari", "\U00011380"),
    # U+1CC00 is assigned in 16.0 with no decomposition; U+1CCF0 is assigned in 16.0 *with* one, to
    # ASCII "0". The pair is the whole divergence in miniature: the first is harmless version skew,
    # the second changes the text a tokenizer sees.
    ("unicode-16-symbols", "\U0001cc00\U0001ccf0"),
    ("unicode-16-outlined-digits", "\U0001ccf0\U0001ccf1\U0001ccf9"),
    ("unicode-16-outlined-letters", "\U0001ccd6\U0001ccd7\U0001ccf9"),
    ("unicode-16-ol-onal", "\U0001e5f0"),
    ("unicode-16-egyptian", "\U00013460"),
    # Astral pairs and lone-surrogate-adjacent shapes, which UTF-16 handling can split.
    ("astral-emoji", "\U0001f600\U0001f601"),
    ("astral-with-modifier", "\U0001f44d\U0001f3fd"),
    ("mixed-script", "编译 compile ＣＯＭＰＩＬＥ"),
    # Whitespace forms recall's tokenizer has to treat consistently.
    ("nbsp", "a b"),
    ("ideographic-space", "a　b"),
    ("zero-width-joiner", "a‍b"),
    ("empty", ""),
)


def vector(name: str, text: str) -> dict[str, object]:
    normalized = unicodedata.normalize("NFKC", text)
    return {
        "name": name,
        "input": text,
        "nfkc": normalized,
        # The pipeline recall actually runs, which is what has to agree.
        "nfkc_lower": normalized.lower(),
        # Recorded so a mismatch says whether the divergence is in normalization or in casing.
        "nfkc_code_points": [ord(character) for character in normalized],
        "categories": [unicodedata.category(character) for character in text],
    }


def build() -> dict[str, object]:
    names = [name for name, _text in CASES]
    if len(set(names)) != len(names):
        raise SystemExit("vector names must be unique")
    return {
        "schema_version": 1,
        "unicode_version": unicodedata.unidata_version,
        "vectors": [vector(name, text) for name, text in CASES],
    }


def export() -> None:
    VECTORS_PATH.write_text(
        json.dumps(build(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def check() -> int:
    if not VECTORS_PATH.is_file():
        print(f"missing {VECTORS_PATH.name}; run with --export", file=sys.stderr)
        return 1
    committed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    produced = build()
    if committed == produced:
        print(f"NFKC vectors match: {len(produced['vectors'])} case(s)")
        return 0
    if committed.get("unicode_version") != produced.get("unicode_version"):
        print(
            "committed vectors were exported against Unicode "
            f"{committed.get('unicode_version')}, this interpreter carries "
            f"{produced.get('unicode_version')}",
            file=sys.stderr,
        )
        return 1
    names = {entry["name"] for entry in committed.get("vectors", ())}
    produced_names = {entry["name"] for entry in produced["vectors"]}
    if names != produced_names:
        print(f"vector set changed: {sorted(names ^ produced_names)}", file=sys.stderr)
        return 1
    by_name = {entry["name"]: entry for entry in committed["vectors"]}
    changed = [entry["name"] for entry in produced["vectors"] if by_name[entry["name"]] != entry]
    print(f"NFKC vector mismatch: {', '.join(changed)}", file=sys.stderr)
    return 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="check", choices=("check", "export"))
    parser.add_argument("--export", action="store_true", help="alias for the export command")
    args = parser.parse_args(argv)
    if args.export or args.command == "export":
        export()
        print(f"exported {VECTORS_PATH.name}")
        return 0
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
