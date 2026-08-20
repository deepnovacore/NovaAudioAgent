"""Python behavioral oracle for the Search executor.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/search_oracle.py check
    uv run python scripts/search_oracle.py export

Two surfaces, both contract-visible for the same reason: everything Search returns is
``untrusted_external`` and reaches the model as evidence.

**URL canonicalization** decides which links survive to become citable sources. A URL that arrives
ambiguous and leaves unambiguous is one whose meaning the code chose, and the agent may later be asked
to act on it -- so the cases here are mostly the ones that must be *refused*.

**Evidence refs** are SHA-256 digests over a canonical JSON body. The model cites them and Memory
stores them, so a one-byte difference means the same search produces two different citations in the two
runtimes. The digest carries a Python ``float`` (``fetched_at``) beside a Python ``int`` (``rank``),
which ``json.dumps`` spells ``2.0`` and ``2`` -- the single most likely place for the two runtimes to
disagree, so the fixture pins whole, fractional, and exponent-form timestamps.

The transport is not exercised: it is one bounded HTTP request, and a fixture that stubbed it would be
measuring the stub. What *is* pinned is how each transport failure code maps to an outcome.
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.executors.search import (  # noqa: E402
    SearchAdapter,
    TavilyTransportFailure,
    _canonical_url,
    _digest,
    _normalize_request,
    _ref,
    _source_label,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "executors" / "search" / "v1" / "cases.json"
EXPECTED = FIXTURE.with_name("cases-expected.json")


class FixtureError(RuntimeError):
    """A case is malformed."""


class _Clock:
    def __init__(self, value: float) -> None:
        self._value = value

    def now(self) -> float:
        return self._value


class _Delegate:
    def __init__(self, delegate_id: str) -> None:
        self.delegate_id = delegate_id


class _Ctx:
    def __init__(self, delegate_id: str, now: float) -> None:
        self.delegate = _Delegate(delegate_id)
        self.clock = _Clock(now)


class _ScriptedTransport:
    """Returns a canned provider response, or raises a canned failure."""

    def __init__(self, spec: Mapping[str, Any]) -> None:
        self._spec = spec

    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        del query, max_results
        failure = self._spec.get("transport_failure")
        if failure is not None:
            raise TavilyTransportFailure(str(failure))
        if self._spec.get("transport_raises") is True:
            raise RuntimeError("adapter boundary")
        response = self._spec.get("response")
        if not isinstance(response, dict):
            raise FixtureError("response must be an object")
        return response


def run_case(spec: Mapping[str, Any]) -> dict[str, Any]:
    kind = spec["kind"]
    if kind == "canonical_url":
        return {"url": _canonical_url(spec["value"])}
    if kind == "source_label":
        return {"label": _source_label(spec["value"])}
    if kind == "normalize_request":
        normalized = _normalize_request(spec["request"])
        return {
            "normalized": None
            if normalized is None
            else {"query": normalized[0], "k": normalized[1]}
        }
    if kind == "digest":
        # Each field declares its spelling, because a shared JSON fixture cannot carry the difference
        # between a Python int and a float -- both reach JavaScript as the same number.
        body: dict[str, Any] = {}
        for field in spec["fields"]:
            raw = field["value"]
            if field["kind"] == "int":
                raw = int(raw)
            elif field["kind"] == "float":
                raw = float(raw)
            body[field["key"]] = raw
        return {
            "digest": _digest(body),
            "ref": _ref(spec.get("ref_kind", "evidence"), body),
        }
    if kind == "dispatch":
        adapter = SearchAdapter(_ScriptedTransport(spec))
        handoff = asyncio.run(
            adapter.dispatch(
                spec.get("op", "search"),
                dict(spec.get("request", {"query": "q", "k": 3})),
                _Ctx(spec.get("delegate_id", "d-1"), float(spec.get("now", 1.0))),
            )
        )
        return {
            "outcome": handoff.outcome,
            "trust": handoff.trust,
            "content": _plain(handoff.content),
            "refs": list(handoff.refs),
        }
    raise FixtureError(f"unsupported case kind: {kind}")


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_plain(item) for item in value]
    return value


def run_all(document: Mapping[str, Any]) -> dict[str, Any]:
    names = [case["name"] for case in document["cases"]]
    if len(set(names)) != len(names):
        raise FixtureError("case names must be unique")
    return {
        "schema_version": 1,
        "cases": [{"name": case["name"], **run_case(case)} for case in document["cases"]],
    }


def load_document() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise FixtureError("unknown search fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(f"Python search parity passed: {len(produced['cases'])} case(s)")
        return 0
    print(_diff(committed, produced), file=sys.stderr)
    return 1


def export() -> None:
    produced = run_all(load_document())
    temporary = EXPECTED.with_suffix(".json.tmp")
    temporary.write_text(_pretty(produced) + "\n", encoding="utf-8")
    temporary.replace(EXPECTED)


def _pretty(value: Any, *, sort_keys: bool = False) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=sort_keys, allow_nan=False)


def _diff(expected: Any, actual: Any) -> str:
    return "\n".join(
        difflib.unified_diff(
            _pretty(expected, sort_keys=True).splitlines(),
            _pretty(actual, sort_keys=True).splitlines(),
            fromfile="cases-expected.json",
            tofile="python-actual.json",
            lineterm="",
        )
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            export()
            print(f"exported {EXPECTED.name}")
            return 0
        return check()
    except FixtureError as error:
        print(f"malformed fixture: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
