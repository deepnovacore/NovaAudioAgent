"""Python behavioral oracle for the realtime service's host-item queue and lifecycle.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/realtime_service_oracle.py check
    uv run python scripts/realtime_service_oracle.py export

This covers the part of `RealtimeService` that decides *order*: which host fact reaches the provider
next. The ordering is a tuple comparison over `(-priority, -preemptive, seq)` pushed through
`heapq`, and every one of those three fields earns its place -- priority because a Guard alert must
not wait behind a routine announcement, preemptive because two facts of equal priority are not
equally interruptive, and the sequence because without it delivery order would depend on what the
heap happened to do with a tie.

The service itself is not constructed here. Building one requires a provider, a session, a bridge and
a runtime, and a fixture that assembled all four would be measuring them rather than the ordering. The
queue is exercised through the same `_QueuedHostResponse` and `heapq` calls the service makes.
"""

from __future__ import annotations

import argparse
import difflib
import heapq
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.memory import USER_PRIORITY  # noqa: E402
from nova_audio_agent.realtime.protocol import HostContextItem, HostResponseIntent  # noqa: E402
from nova_audio_agent.realtime.service import (  # noqa: E402
    HIT_ALERT_MIN_PRIORITY,
    MAX_HOST_FACT_CHARS,
    PREEMPT_MIN_PRIORITY,
    _GuardActivationAuthority,
    _QueuedHostResponse,
)
from nova_audio_agent.realtime.evidence import (  # noqa: E402
    final_speech_view,
    generic_final_speech_view,
)
from nova_audio_agent.realtime.speech_prep import (  # noqa: E402
    SPEECH_FINAL_LIMIT,
    prepare_for_speech,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "service" / "v1" / "scenarios.json"
EXPECTED = FIXTURE.with_name("scenarios-expected.json")


class FixtureError(RuntimeError):
    """A scenario is malformed."""


def _intent(event_id: str) -> HostResponseIntent:
    return HostResponseIntent.host_fact(
        HostContextItem.final(host_item_id=f"host-{event_id}", event_id=event_id, content="x")
    )


def run_scenario(spec: Mapping[str, Any]) -> dict[str, Any]:
    heap: list[_QueuedHostResponse] = []
    seq = 0
    armed: int | None = None
    steps: list[dict[str, Any]] = []

    for index, step in enumerate(spec["steps"]):
        kind = step["kind"]
        result: Any = None
        if kind == "queue":
            priority = step.get("priority", 50)
            preemptive = step.get("preemptive", False)
            effective = min(priority, USER_PRIORITY - 1)
            seq += 1
            guard_delegate_id = step.get("guard_delegate_id")
            queued = _QueuedHostResponse(
                sort_key=(-effective, -int(preemptive), seq),
                intent=_intent(step["event_id"]),
                priority=effective,
                preemptive=preemptive,
                seq=seq,
                queued_at=float(step.get("at", 0.0)),
                semantic_event_id=step.get("semantic_event_id"),
                guard_activation=(
                    None
                    if guard_delegate_id is None
                    else _GuardActivationAuthority(
                        delegate_id=guard_delegate_id,
                        event_id=step["event_id"],
                        source_epoch=step.get("source_epoch", 1),
                    )
                ),
            )
            heapq.heappush(heap, queued)
            if preemptive:
                armed = effective if armed is None else max(effective, armed)
            result = {"seq": seq, "effective_priority": effective}
        elif kind == "pop":
            if not heap:
                result = None
            else:
                popped = heapq.heappop(heap)
                result = {
                    "event_id": popped.intent.item.event_id,
                    "priority": popped.priority,
                    "preemptive": popped.preemptive,
                    "seq": popped.seq,
                }
                if popped.preemptive:
                    armed = max(
                        (candidate.priority for candidate in heap if candidate.preemptive),
                        default=None,
                    )
        elif kind == "drain":
            drained: list[dict[str, Any]] = []
            while heap:
                popped = heapq.heappop(heap)
                drained.append(
                    {
                        "event_id": popped.intent.item.event_id,
                        "priority": popped.priority,
                        "preemptive": popped.preemptive,
                        "seq": popped.seq,
                    }
                )
            armed = None
            result = drained
        else:
            raise FixtureError(f"unsupported step kind: {kind}")

        steps.append(
            {
                "step": index,
                "kind": kind,
                "result": result,
                "armed_preempt_priority": armed,
                "eligible_preempt": armed is not None and armed >= PREEMPT_MIN_PRIORITY,
                "queued_order": [
                    {"event_id": item.intent.item.event_id, "seq": item.seq}
                    for item in sorted(heap)
                ],
            }
        )
    return {"name": spec["name"], "steps": steps}


def run_projection(spec: Mapping[str, Any]) -> dict[str, Any]:
    """The spoken text one projected event produces.

    Not the whole service: assembling one would measure the provider and session instead. What is
    pinned here is the part a user hears -- the wording, the elapsed-seconds rendering, and the
    priority the fact is queued at -- because those are what differ between two runtimes that both
    "work".
    """
    display_name = spec["display_name"]
    kind = spec["kind"]
    if kind == "deadline":
        return {"content": f"{display_name} 的委派任务超时，未能确认结果。"}
    if kind == "progress_started":
        return {"content": f"{display_name} 已开始处理这个任务。"}
    if kind == "progress_summary":
        summary = prepare_for_speech(spec["summary"], limit=SPEECH_FINAL_LIMIT)[0] or None
        elapsed = float(spec["elapsed"])
        return {
            "summary": summary,
            "content": (
                None
                if summary is None
                else f"{display_name} 正在执行：{summary}（已进行{elapsed:.0f}秒）"
            ),
        }
    if kind == "progress_steps":
        return {
            "content": (
                f"{display_name} 仍在处理这个任务，目前已推进 {spec['internal_activity']} 个步骤。"
            )
        }
    if kind == "final_codex":
        view = final_speech_view(spec["outcome"], spec["content"])
        return {"content": view[:MAX_HOST_FACT_CHARS]}
    if kind == "final_generic":
        view = generic_final_speech_view(display_name, spec["outcome"], spec["content"])
        return {"content": view[:MAX_HOST_FACT_CHARS]}
    if kind == "hit_priority":
        manifest_priority = spec["manifest_priority"]
        return {
            "priority": max(manifest_priority, HIT_ALERT_MIN_PRIORITY)
            if spec["hit"]
            else manifest_priority,
            "preemptive": manifest_priority >= PREEMPT_MIN_PRIORITY and spec["hit"],
        }
    raise FixtureError(f"unsupported projection kind: {kind}")


def run_all(document: Mapping[str, Any]) -> dict[str, Any]:
    names = [scenario["name"] for scenario in document["scenarios"]]
    if len(set(names)) != len(names):
        raise FixtureError("scenario names must be unique")
    projection_names = [spec["name"] for spec in document.get("projections", [])]
    if len(set(projection_names)) != len(projection_names):
        raise FixtureError("projection names must be unique")
    return {
        "schema_version": 1,
        "constants": {
            "preempt_min_priority": PREEMPT_MIN_PRIORITY,
            "user_priority": USER_PRIORITY,
        },
        "scenarios": [run_scenario(scenario) for scenario in document["scenarios"]],
        "projections": [
            {"name": spec["name"], **run_projection(spec)}
            for spec in document.get("projections", [])
        ],
    }


def load_document() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise FixtureError("unknown service fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(
            f"Python service parity passed: {len(produced['scenarios'])} scenario(s), "
            f"{len(produced['projections'])} projection(s)"
        )
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
            fromfile="scenarios-expected.json",
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
