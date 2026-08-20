"""Python behavioral oracle for the Watch and Guard executors.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/watcher_oracle.py check
    uv run python scripts/watcher_oracle.py export

Two surfaces are pinned.

**The verdict parser** reads model output about a camera frame. It is `untrusted_external` by
definition, and the parser is strict to the point of rudeness: a hit must carry an observation, a miss
must carry an empty one, and nothing is repaired. A repaired verdict is one whose meaning this code
chose about untrusted output.

**The state machine** is the debounce. A condition that is met stays met for several frames, so a naive
"announce every matching frame" would report the same event five times in ten seconds. A hit moves to
`cooling`, and re-arming takes *two consecutive misses* -- one is not enough, because a subject that
briefly leaves the frame has not stopped being there.

The monitoring loop's timing is not pinned: it is an asyncio loop there and a promise chain here, and a
fixture over it would compare two schedulers. What is pinned is the sequence of states and observations
a given run of verdicts produces.
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.executors.watcher import (  # noqa: E402
    WatchStatus,
    _normalize_start,
    _printable,
    _printable_text,
    parse_watch_verdict,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "executors" / "watcher" / "v1" / "cases.json"
EXPECTED = FIXTURE.with_name("cases-expected.json")


class FixtureError(RuntimeError):
    """A case is malformed."""


def _transitions(verdicts: Sequence[bool]) -> list[dict[str, Any]]:
    """Replay the state machine over a sequence of verdicts.

    Mirrors the four transitions in `WatchAdapter._start` without the loop around them, so the
    debounce is pinned independently of the scheduler that drives it.
    """
    status = WatchStatus(state="armed", condition="c", started_at=0.0)
    steps: list[dict[str, Any]] = []
    for index, hit in enumerate(verdicts):
        announced = False
        if hit and status.state == "armed":
            status = replace(status, hit_count=status.hit_count + 1, reset_count=0)
            announced = True
            status = replace(status, state="cooling")
        elif hit and status.state == "waiting_reset":
            status = replace(status, state="cooling", reset_count=0)
        elif not hit and status.state == "cooling":
            status = replace(status, state="waiting_reset", reset_count=1)
        elif not hit and status.state == "waiting_reset":
            status = replace(status, state="armed", reset_count=0)
        steps.append(
            {
                "step": index,
                "hit": hit,
                "announced": announced,
                "state": status.state,
                "hit_count": status.hit_count,
                "reset_count": status.reset_count,
            }
        )
    return steps


def run_case(spec: Mapping[str, Any]) -> dict[str, Any]:
    kind = spec["kind"]
    if kind == "verdict":
        try:
            verdict = parse_watch_verdict(spec["text"])
        except ValueError:
            return {"error": "invalid verdict"}
        return {"hit": verdict.hit, "observation": verdict.observation}
    if kind == "normalize_start":
        normalized = _normalize_start(spec["request"])
        return {
            "normalized": None
            if normalized is None
            else {
                "condition": normalized[0],
                "interval_s": normalized[1],
                "duration_s": normalized[2],
            }
        }
    if kind == "printable":
        return {
            "printable": _printable(spec["value"]),
            "printable_text": _printable_text(
                spec["value"], allow_empty=spec.get("allow_empty", False)
            ),
        }
    if kind == "state_machine":
        return {"steps": _transitions(spec["verdicts"])}
    raise FixtureError(f"unsupported case kind: {kind}")


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
        raise FixtureError("unknown watcher fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(f"Python watcher parity passed: {len(produced['cases'])} case(s)")
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
