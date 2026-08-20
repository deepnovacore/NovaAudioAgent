from __future__ import annotations

import json

import pytest

from scripts.search_oracle import EXPECTED, FIXTURE, main, run_all

pytestmark = pytest.mark.fixture_replay


def test_python_search_matches_the_committed_golden(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check"]) == 0
    assert "parity passed" in capsys.readouterr().out


def test_case_names_are_unique_and_ordered_with_the_golden() -> None:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    names = [case["name"] for case in document["cases"]]
    assert len(set(names)) == len(names)
    assert [case["name"] for case in golden["cases"]] == names


def test_url_canonicalization_refuses_more_than_it_accepts() -> None:
    # It is a security boundary, not a formatter. A set that mostly accepted would pass with every
    # refusal deleted, and each refusal is a URL whose meaning the code would otherwise be choosing.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    urls = [case for case in golden["cases"] if "url" in case]
    refused = [case for case in urls if not case["url"]]
    assert len(refused) >= 25
    assert len(urls) - len(refused) >= 15


def test_no_accepted_url_carries_userinfo_or_a_fragment() -> None:
    # The two rewrites that matter: userinfo is refused outright because no rendering of it is honest,
    # and a fragment is dropped because it is client-side only and two results differing by one are the
    # same evidence.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for case in golden["cases"]:
        url = case.get("url")
        if not url:
            continue
        authority = url.split("://", 1)[1].split("/", 1)[0]
        assert "@" not in authority, case["name"]
        assert "#" not in url, case["name"]


def test_every_successful_dispatch_cites_each_result() -> None:
    # The refs are what the model may point at. A result in the content but absent from the refs would
    # be evidence the agent is not allowed to cite.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    for case in golden["cases"]:
        if case.get("outcome") != "ok":
            continue
        content = case["content"]
        refs = case["refs"]
        assert content["query_ref"] in refs, case["name"]
        for result in content["results"]:
            assert result["evidence_ref"] in refs, case["name"]
        assert len(refs) == len(content["results"]) + 1, case["name"]


def test_a_failure_carries_no_provider_detail() -> None:
    # The content reaches the model. A provider message could carry a key, a URL, or an internal
    # identifier, so only the normalized code crosses.
    golden = json.loads(EXPECTED.read_text(encoding="utf-8"))
    allowed = {"error", "provider", "query", "query_ref", "fetched_at"}
    for case in golden["cases"]:
        if case.get("outcome") in {None, "ok"}:
            continue
        assert set(case["content"]) <= allowed, case["name"]


def test_the_golden_is_recomputed_rather_than_trusted() -> None:
    produced = run_all(json.loads(FIXTURE.read_text(encoding="utf-8")))
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert produced["cases"] == committed["cases"]
