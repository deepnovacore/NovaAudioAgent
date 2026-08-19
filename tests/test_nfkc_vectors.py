from __future__ import annotations

import json
import unicodedata
from pathlib import Path

import pytest

from scripts.generate_nfkc_vectors import VECTORS_PATH, build, main

pytestmark = pytest.mark.fixture_replay


def test_committed_vectors_match_this_interpreter(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "NFKC vectors match" in capsys.readouterr().out


def test_vectors_were_exported_against_the_pinned_unicode_version() -> None:
    # The Node leg asserts the same version. If CPython moves, both legs have to be re-derived
    # rather than one silently following the interpreter.
    committed = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    assert committed["unicode_version"] == unicodedata.unidata_version
    tables = Path("runtime/src/unicode-tables.ts").read_text(encoding="utf-8")
    assert f"PINNED_UNICODE_VERSION = '{unicodedata.unidata_version}'" in tables


def test_the_set_covers_the_version_skew_it_exists_to_detect() -> None:
    # Vectors made only of long-assigned characters would prove nothing about database skew.
    skewed = [vector for vector in build()["vectors"] if vector["name"].startswith("unicode-16-")]
    assert len(skewed) >= 5
    for vector in skewed:
        assert "Cn" in vector["categories"], vector["name"]


def test_the_outlined_forms_are_left_alone_by_this_database() -> None:
    # The specific divergence the Node holdback exists for: ICU decomposes these to ASCII, and this
    # database does not know them at all. If a future CPython does, the holdback can be retired.
    for text in ("\U0001ccf0", "\U0001ccd6"):
        assert unicodedata.normalize("NFKC", text) == text
        assert unicodedata.category(text) == "Cn"
