"""Python behavioral oracle for the memory-recall projection.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/recall_oracle.py check
    uv run python scripts/recall_oracle.py export

Recall decides which past memories a model is shown, so both its selection and its encoded bytes
are contract-visible. The golden therefore records the whole view -- state, counts, truncation flag,
every hit in order -- plus the encoded envelope at several budgets, because dropping a hit to fit is
part of the behavior rather than a formatting detail.
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.memory import HandoffPolicy, Memory  # noqa: E402
from nova_audio_agent.realtime.recall import (  # noqa: E402
    RecallOriginError,
    compile_memory_recall,
    encode_memory_recall,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "recall" / "v1" / "scenarios.json"
EXPECTED = FIXTURE.with_name("scenarios-expected.json")


class FixtureError(RuntimeError):
    """A scenario is malformed."""


def build_memory(spec: Mapping[str, Any]) -> Memory:
    """Construct Memory from a scenario's declared channels and items."""
    # Recall reads items and never consults a policy, so the fields beyond the channel name are
    # placeholders chosen to be valid rather than meaningful.
    policies = tuple(
        HandoffPolicy(
            channel=channel["name"],
            priority=channel.get("priority", 50),
            wake=channel.get("wake", "none"),
            typical_latency=channel.get("typical_latency", 1.0),
            compress_watermark=channel.get("compress_watermark", 100),
        )
        for channel in spec["channels"]
        if channel["name"] != "conversation"
    )
    memory = Memory(policies=policies)
    for item in spec["items"]:
        memory.append(
            item["channel"],
            ts=item["ts"],
            trust=item["trust"],
            priority=item["priority"],
            content=dict(item["content"]),
            outcome=item.get("outcome"),
        )
    return memory


def run_scenario(spec: Mapping[str, Any]) -> dict[str, Any]:
    memory = build_memory(spec)
    try:
        view = compile_memory_recall(
            memory,
            query=spec["query"],
            scope=spec["scope"],
            before_ref=spec["before_ref"],
        )
    except RecallOriginError as error:
        return {"name": spec["name"], "error": {"kind": "origin", "message": str(error)}}
    except ValueError as error:
        return {"name": spec["name"], "error": {"kind": "value", "message": str(error)}}

    encodings: list[dict[str, Any]] = []
    for max_chars in spec.get("encode_budgets", [3000]):
        try:
            encodings.append(
                {"max_chars": max_chars, "encoded": encode_memory_recall(view, max_chars=max_chars)}
            )
        except ValueError as error:
            encodings.append({"max_chars": max_chars, "error": str(error)})
    return {
        "name": spec["name"],
        "view": {
            "state": view.state,
            "scope": view.scope,
            "raw_scanned": view.raw_scanned,
            "searched_count": view.searched_count,
            "scan_truncated": view.scan_truncated,
            "omitted": view.omitted,
            "hits": [asdict(hit) for hit in view.hits],
        },
        "encodings": encodings,
    }


def run_all(scenarios: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    names = [scenario["name"] for scenario in scenarios]
    if len(set(names)) != len(names):
        raise FixtureError("scenario names must be unique")
    return {
        "schema_version": 1,
        "scenarios": [run_scenario(scenario) for scenario in scenarios],
    }


def load_scenarios() -> list[dict[str, Any]]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise FixtureError("unknown recall fixture schema version")
    return list(document["scenarios"])


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_scenarios())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(f"Python recall parity passed: {len(produced['scenarios'])} scenario(s)")
        return 0
    print(_diff(committed, produced), file=sys.stderr)
    return 1


def export() -> None:
    produced = run_all(load_scenarios())
    temporary = EXPECTED.with_suffix(".json.tmp")
    temporary.write_text(_pretty(produced) + "\n", encoding="utf-8")
    temporary.replace(EXPECTED)


def _pretty(value: Any, *, sort_keys: bool = False) -> str:
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=sort_keys, allow_nan=False)
    return "".join(
        f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in rendered
    )


def _diff(expected: Any, actual: Any) -> str:
    return "\n".join(
        difflib.unified_diff(
            _pretty(expected, sort_keys=True).splitlines(),
            _pretty(actual, sort_keys=True).splitlines(),
            fromfile="scenarios-expected.json",
            tofile="python-actual.json",
            lineterm="",
        )
    )


def main(argv: Sequence[str] | None = None) -> int:
    # Take an explicit argv so an embedding test runner's own arguments cannot leak in.
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
