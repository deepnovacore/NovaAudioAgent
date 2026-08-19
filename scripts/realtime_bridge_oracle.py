"""Python behavioral oracle for the realtime runtime bridge.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/realtime_bridge_oracle.py check
    uv run python scripts/realtime_bridge_oracle.py export

The bridge is the only route by which a provider's tool calls and user transcripts reach the reducer,
so what it admits, refuses, and dispatches *is* the authorization boundary for model-proposed work.
The runtime underneath is a scripted double on both legs: the point is to pin the bridge's decisions,
and a real runtime would make the fixture measure the reducer instead.

Executor manifests are carried in the fixture rather than hardcoded here. Two hardcoded registries
would be two things to keep in step; one JSON document parsed by both legs cannot drift.
"""

from __future__ import annotations

import argparse
import asyncio
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
from nova_audio_agent.clock import VirtualClock  # noqa: E402
from nova_audio_agent.memory import HandoffPolicy, Memory  # noqa: E402
from nova_audio_agent.ports import ExecutorManifest, OpSpec  # noqa: E402
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge  # noqa: E402
from nova_audio_agent.realtime.protocol import ToolCallReady  # noqa: E402
from nova_audio_agent.tool_schema import compile_tool_schema  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "bridge" / "v1" / "scenarios.json"
EXPECTED = FIXTURE.with_name("scenarios-expected.json")

# Fixed so the digest is reproducible across runs. Production uses a random per-process key; this is
# the one place a stable key is correct, because the golden has to be byte-identical.
DIGEST_KEY = bytes(range(32))


class FixtureError(RuntimeError):
    """A scenario is malformed."""


class ScriptedRuntime:
    """A runtime double whose admissions come from the fixture.

    Records every call so the golden pins not just what the bridge returned but what it asked the
    runtime to do -- an acceptance that dispatched the wrong request would otherwise look identical.
    """

    def __init__(
        self,
        *,
        clock: VirtualClock,
        memory: Memory,
        executors: Mapping[str, Any],
        script: Mapping[str, Any],
    ) -> None:
        self.clock = clock
        self.memory = memory
        self.executors = dict(executors)
        self.calls: list[dict[str, Any]] = []
        self._ingest = list(script.get("ingest_refs", []))
        self._updates = list(script.get("update_results", []))
        self._dispatches = list(script.get("dispatch_results", []))

    async def ingest_user_input(self, user_input: Any) -> str:
        if not self._ingest:
            raise FixtureError("ingest_refs exhausted")
        reference = self._ingest.pop(0)
        self.calls.append({"call": "ingest_user_input", "text": user_input.text, "ref": reference})
        return reference

    def update_external(self, spec: Any, *, reason: Any) -> bool:
        if not self._updates:
            raise FixtureError("update_results exhausted")
        accepted = self._updates.pop(0)
        self.calls.append(
            {
                "call": "update_external",
                "target": spec.target,
                "delta": dict(spec.delta),
                "routing_class": reason.routing_class,
                "priority": reason.priority,
                "accepted": accepted,
            }
        )
        return accepted

    def dispatch_external(self, request: Any, *, reason: Any) -> Any:
        if not self._dispatches:
            raise FixtureError("dispatch_results exhausted")
        scripted = self._dispatches.pop(0)
        self.calls.append(
            {
                "call": "dispatch_external",
                "executor": request.executor,
                "op": request.op,
                "request": dict(request.request),
                "origin_ref": request.origin_ref,
                "routing_class": reason.routing_class,
                "priority": reason.priority,
            }
        )

        class _Result:
            accepted = scripted["accepted"]
            delegate_id = scripted.get("delegate_id")

        return _Result()

    def unconsumed(self) -> dict[str, int]:
        return {
            "ingest_refs": len(self._ingest),
            "update_results": len(self._updates),
            "dispatch_results": len(self._dispatches),
        }


def build_manifest(spec: Mapping[str, Any]) -> ExecutorManifest:
    policy = spec["policy"]
    return ExecutorManifest(
        name=spec["name"],
        policy=HandoffPolicy(
            channel=policy["channel"],
            priority=policy["priority"],
            wake=policy["wake"],
            typical_latency=policy["typical_latency"],
            compress_watermark=policy["compress_watermark"],
            suggest=policy.get("suggest", False),
            progress_via_surrogate=policy.get("progress_via_surrogate", False),
        ),
        ops=tuple(
            OpSpec(
                name=op["name"],
                description=op["description"],
                params=dict(op["params"]),
                readonly=op.get("readonly", False),
                confirm=op.get("confirm", False),
                deadline_budget=op.get("deadline_budget", 30.0),
                verifies=tuple(op.get("verifies", ())),
                sensitive_params=tuple(op.get("sensitive_params", ())),
                sync_result=op.get("sync_result", False),
            )
            for op in spec["ops"]
        ),
    )


async def run_scenario(spec: Mapping[str, Any]) -> dict[str, Any]:
    clock = VirtualClock()
    manifests = [build_manifest(entry) for entry in spec["manifests"]]
    memory = Memory(policies=tuple(manifest.policy for manifest in manifests))
    for item in spec.get("memory", []):
        memory.append(
            item["channel"],
            ts=item["ts"],
            trust=item["trust"],
            priority=item["priority"],
            content=dict(item["content"]),
        )
    executors = {
        manifest.name: type("_Adapter", (), {"manifest": manifest})() for manifest in manifests
    }
    runtime = ScriptedRuntime(
        clock=clock,
        memory=memory,
        executors=executors,
        script=spec.get("runtime", {}),
    )
    tools = compile_tool_schema(
        manifests,
        include_memory_recall=spec.get("include_memory_recall", False),
    )
    identifiers = iter(spec.get("ids", [f"id-{index}" for index in range(1, 41)]))

    def id_factory() -> str:
        try:
            return next(identifiers)
        except StopIteration as error:
            raise FixtureError("id sequence exhausted") from error

    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=id_factory)
    bridge._query_digest_key = DIGEST_KEY  # noqa: SLF001 - reproducible telemetry digests

    steps: list[dict[str, Any]] = []
    for index, step in enumerate(spec["steps"]):
        kind = step["kind"]
        call_mark = len(runtime.calls)
        result: Any
        try:
            if kind == "accept_user_transcript":
                result = await bridge.accept_user_transcript(step["text"])
            elif kind == "accept_tool_call":
                acceptance = await bridge.accept_tool_call(
                    ToolCallReady(
                        session_epoch=step.get("session_epoch", 1),
                        call_id=step["call_id"],
                        item_id=step.get("item_id", "item-1"),
                        name=step["name"],
                        arguments=dict(step.get("arguments", {})),
                        response_id=step.get("response_id"),
                    ),
                    origin_ref=step.get("origin_ref"),
                )
                result = render_acceptance(acceptance)
            elif kind == "advance_clock":
                clock.advance_to(step["to"])
                result = None
            else:
                raise FixtureError(f"unsupported step kind: {kind}")
        except FixtureError:
            raise
        except (ValueError, TypeError) as error:
            result = {"error": type(error).__name__, "message": str(error)}
        steps.append(
            {
                "step": index,
                "kind": kind,
                "result": result,
                "runtime_calls": runtime.calls[call_mark:],
            }
        )

    unconsumed = runtime.unconsumed()
    if any(unconsumed.values()) and not spec.get("allow_unconsumed", False):
        raise FixtureError(f"{spec['name']}: unconsumed runtime script {unconsumed}")
    return {"name": spec["name"], "steps": steps}


def render_acceptance(acceptance: Any) -> dict[str, Any]:
    telemetry = acceptance.telemetry
    return {
        "accepted": acceptance.accepted,
        "code": acceptance.code,
        "host_item": asdict(acceptance.host_item),
        "response_intent": asdict(acceptance.response_intent),
        "delegate_id": acceptance.delegate_id,
        "sync_result": acceptance.sync_result,
        "executor": acceptance.executor,
        "op": acceptance.op,
        "inline_fulfilled": acceptance.inline_fulfilled,
        "telemetry": None if telemetry is None else _plain(dict(telemetry)),
    }


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_plain(item) for item in value]
    return value


def run_all(document: Mapping[str, Any]) -> dict[str, Any]:
    names = [scenario["name"] for scenario in document["scenarios"]]
    if len(set(names)) != len(names):
        raise FixtureError("scenario names must be unique")
    return {
        "schema_version": 1,
        "scenarios": [asyncio.run(run_scenario(scenario)) for scenario in document["scenarios"]],
    }


def load_document() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise FixtureError("unknown bridge fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(f"Python bridge parity passed: {len(produced['scenarios'])} scenario(s)")
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
