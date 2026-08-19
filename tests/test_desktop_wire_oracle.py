from __future__ import annotations

import json

import pytest

from scripts.desktop_wire_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_desktop_wire_matches_the_committed_golden(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_case_names_are_unique_and_ordered_with_the_golden() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    names = [case["name"] for case in document["cases"]]
    assert len(set(names)) == len(names)
    assert [case["name"] for case in golden["cases"]] == names


def test_the_case_set_covers_acceptance_and_refusal() -> None:
    # A set of only valid frames would pass with every bound deleted. Most of this module is refusal,
    # and a frame one runtime accepts while the other refuses is the same interoperability failure as a
    # frame they encode differently.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    accepted = sum(1 for case in golden["cases"] if "error" not in case)
    refused = sum(1 for case in golden["cases"] if "error" in case)
    assert accepted >= 15
    assert refused >= 15


def test_every_audio_frame_carries_the_magic_and_a_big_endian_length() -> None:
    # The framing itself, asserted on the bytes: magic first so a non-frame is rejected before its
    # length is trusted, then a two-byte big-endian header size.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for case in golden["cases"]:
        raw = case.get("bytes")
        if raw is None or "error" in case or not raw.startswith("4e4f5641"):
            continue
        header_size = int(raw[8:12], 16)
        assert 2 <= header_size <= 2048, case["name"]
        # The header is ASCII-only, which is what `ensure_ascii=True` guarantees.
        header = bytes.fromhex(raw[12 : 12 + header_size * 2])
        assert header.decode("ascii")


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["cases"] == committed["cases"]
