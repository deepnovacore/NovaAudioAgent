"""Pin the Unicode version the cross-language progress-summary contract assumes.

``valid_progress_summary`` rejects any character whose general category starts with
C. Python answers that from CPython's bundled Unicode database and V8 answers
``/\\p{C}/u`` from ICU's, and those versions differ, so the Node runtime consults a
generated table pinned to the version below instead of a ``\\p{...}`` escape.

These tests make an interpreter upgrade an explicit decision: if CPython starts
carrying a different Unicode version, or the generated table stops agreeing with
this interpreter, the suite fails rather than quietly changing what a committed
fixture means.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import pytest

from nova_audio_agent.ports import valid_progress_summary

PINNED_UNICODE_VERSION = "15.0.0"
GENERATED_TABLE = Path("runtime/src/unicode-tables.ts")
CASEFOLD_HELPER = Path("runtime/src/unicode-casefold.ts")

#: Cn at 15.0.0, assigned symbols at 16.0. The generated table must keep rejecting
#: these so Node agrees with this interpreter.
ASSIGNED_AFTER_PIN = (0x1CC00, 0x1E5D0, 0x10D40)


def test_this_interpreter_still_carries_the_pinned_unicode_version() -> None:
    assert unicodedata.unidata_version == PINNED_UNICODE_VERSION, (
        "CPython's Unicode version moved. Every committed fixture was exported "
        "against the pinned version, so re-pinning is a deliberate contract change: "
        "update PINNED_UNICODE_VERSION here and in "
        "scripts/generate_unicode_tables.py, regenerate the table, and re-export "
        "any fixture whose expected output depends on character classification."
    )


@pytest.mark.parametrize("prefix", ["C", "P", "L", "N"])
def test_the_generated_node_table_declares_the_same_pin(prefix: str) -> None:
    # Each table records its own range and code-point counts, and both are re-derived here rather
    # than trusted: a table generated against a different interpreter would otherwise pass.
    source = GENERATED_TABLE.read_text(encoding="utf-8")
    assert f"export const PINNED_UNICODE_VERSION = '{PINNED_UNICODE_VERSION}'" in source
    declared = re.search(
        rf"^// {prefix}\*: .*\n(?://.*\n)*?// (\d+) ranges covering (\d+) code points",
        source,
        re.MULTILINE,
    )
    assert declared is not None, f"the generated {prefix}* header must record its counts"
    ranges, covered = _ranges_for_this_interpreter(prefix)
    assert int(declared.group(1)) == ranges
    assert int(declared.group(2)) == covered


def test_the_punctuation_table_covers_what_confirmation_matching_strips() -> None:
    # `project_confirmation.py` strips P* and C* before matching, so the Node port needs the same
    # answer for the characters a Chinese confirmation utterance actually carries.
    for character in "。，、！？：；（）「」『』——…":
        assert unicodedata.category(character).startswith("P"), character


def test_project_casefold_exception_table_matches_every_python_scalar() -> None:
    source = CASEFOLD_HELPER.read_text(encoding="utf-8")
    encoded = re.search(r"^const CASEFOLD_EXCEPTIONS = '([^']*)'$", source, re.MULTILINE)
    assert encoded is not None
    declared = {
        int(origin, 16): "".join(chr(int(value, 16)) for value in folded.split(","))
        for entry in encoded.group(1).split(";")
        for origin, folded in [entry.split(":", maxsplit=1)]
    }
    expected = {
        code_point: chr(code_point).casefold()
        for code_point in range(0x110000)
        if not 0xD800 <= code_point <= 0xDFFF
        and chr(code_point).casefold() != chr(code_point).lower()
    }
    assert declared == expected


def test_code_points_assigned_after_the_pin_are_still_rejected() -> None:
    for code_point in ASSIGNED_AFTER_PIN:
        character = chr(code_point)
        assert unicodedata.category(character) == "Cn", f"U+{code_point:04X}"
        assert not valid_progress_summary(f"working on {character}", phase="working")


@pytest.mark.parametrize(
    ("summary", "phase", "expected"),
    [
        (None, "started", True),
        (None, "working", True),
        ("anything", "started", False),
        ("", "working", False),
        ("ok", "working", True),
        ("has\x00null", "working", False),
        ("newline\n", "working", False),
        ("soft\u00adhyphen", "working", False),
        ("zero\u200bwidth", "working", False),
        ("\U0001f600" * 400, "working", True),
        ("\U0001f600" * 401, "working", False),
    ],
)
def test_progress_summary_contract_is_stable(summary: object, phase: str, expected: bool) -> None:
    assert valid_progress_summary(summary, phase=phase) is expected


def _ranges_for_this_interpreter(prefix: str) -> tuple[int, int]:
    """The range count and covered code-point count this interpreter would generate."""
    ranges = 0
    covered = 0
    inside = False
    for code_point in range(0x110000):
        matches = unicodedata.category(chr(code_point)).startswith(prefix)
        if matches:
            covered += 1
            if not inside:
                ranges += 1
        inside = matches
    return ranges, covered
