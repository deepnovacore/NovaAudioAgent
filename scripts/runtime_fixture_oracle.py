"""Python behavioral oracle for the Node runtime migration fixtures.

Normal checks are read-only. Updating ``expected.json`` requires the explicit
``export`` command so behavioral golden changes remain visible in review.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import difflib
import json
import math
import sys
from collections import defaultdict
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from nova_audio_agent.canonical_json import canonical_json
from nova_audio_agent.clock import Clock, VirtualClock
from nova_audio_agent.events import (
    HandoffEvent,
    ModelDone,
    ObservationEvent,
    ProgressEvent,
    UserInput,
)
from nova_audio_agent.floor import FloorDecision
from nova_audio_agent.memory import HandoffPolicy, Memory
from nova_audio_agent.ports import (
    ActionDelta,
    ActionOutput,
    Compressor,
    ContractFailureDelta,
    Delegate,
    DelegateRequest,
    DispatchContext,
    ExecutorManifest,
    FastBrain,
    FastBrainDelta,
    Handoff,
    ObservationPayload,
    OpSpec,
    ProgressPayload,
    SpeakActDelta,
    Surrogate,
    SurrogateOutput,
    TextDelta,
    UpdateSpec,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.realtime.playback import PlaybackFrame, PlaybackRegistry
from nova_audio_agent.speech import RecordingSink
from nova_audio_agent.trace import to_record


REPOSITORY_ROOT = Path(__file__).parents[1]
DEFAULT_FIXTURE_ROOT = REPOSITORY_ROOT / "fixtures" / "runtime" / "v1"
SCHEMA_PATH = DEFAULT_FIXTURE_ROOT / "schema.json"
PROACTIVITY = {
    "conservative": (120.0, 20.0),
    "balanced": (60.0, 30.0),
    "eager": (30.0, 45.0),
}


class FixtureError(RuntimeError):
    pass


class ScriptedFastBrain(FastBrain):
    def __init__(
        self,
        completions: Sequence[Mapping[str, Any]],
        *,
        clock: Clock,
        model_views: list[dict[str, Any]],
    ) -> None:
        self._completions = list(completions)
        self._clock = clock
        self._model_views = model_views
        self.calls = 0

    async def call(self, view: object) -> AsyncIterator[FastBrainDelta]:
        self.calls += 1
        self._model_views.append({"slot": "fast", "view": asdict(view)})  # type: ignore[arg-type]
        completion = self._take("fastbrain")
        if completion["delay"] > 0:
            await self._clock.sleep(completion["delay"])
        output = _parse_fastbrain_output(completion["output"])
        if output is None:
            yield ContractFailureDelta(code="invalid_fastbrain_output", tool_name=None)
            return
        speak, action = output
        if speak[1]:
            yield TextDelta(text=speak[1])
        if speak[0] == "ask":
            yield SpeakActDelta(act="ask")
        if action.act != "none":
            yield ActionDelta(action=action)

    def _take(self, port: str) -> Mapping[str, Any]:
        if not self._completions:
            raise FixtureError(f"missing scripted {port} output")
        return self._completions.pop(0)

    def assert_exhausted(self) -> None:
        if self._completions:
            raise FixtureError(f"unused fastbrain outputs: {len(self._completions)}")


class ScriptedSurrogate(Surrogate):
    def __init__(
        self,
        completions: Sequence[Mapping[str, Any]],
        *,
        clock: Clock,
        diagnostics: list[dict[str, Any]],
        model_views: list[dict[str, Any]],
    ) -> None:
        self._completions = list(completions)
        self._clock = clock
        self._diagnostics = diagnostics
        self._model_views = model_views

    async def watch(self, view: object) -> SurrogateOutput:
        self._model_views.append(
            {"slot": "surrogate.watch", "view": asdict(view)}  # type: ignore[arg-type]
        )
        if not self._completions:
            raise FixtureError("missing scripted surrogate.watch output")
        completion = self._completions.pop(0)
        if completion["delay"] > 0:
            await self._clock.sleep(completion["delay"])
        output = completion["output"]
        if not _valid_surrogate_output(output):
            self._diagnostics.append({"code": "invalid_surrogate_output"})
            return SurrogateOutput(speak=False)
        return SurrogateOutput(
            speak=output["speak"],
            suggestion_id=output.get("suggestion_id"),
            reason=output.get("reason", ""),
        )

    def assert_exhausted(self) -> None:
        if self._completions:
            raise FixtureError(f"unused surrogate.watch outputs: {len(self._completions)}")


class ScriptedCompressor(Compressor):
    def __init__(
        self,
        completions: Sequence[Mapping[str, Any]],
        *,
        clock: Clock,
        diagnostics: list[dict[str, Any]],
    ) -> None:
        self._completions = list(completions)
        self._clock = clock
        self._diagnostics = diagnostics

    async def compress(self, items: Sequence[object]) -> str:
        if not self._completions:
            raise FixtureError("missing scripted compress output")
        completion = self._completions.pop(0)
        if completion["delay"] > 0:
            await self._clock.sleep(completion["delay"])
        output = completion["output"]
        if not items:
            self._diagnostics.append({"code": "invalid_compressor_output"})
            return ""
        channel = items[0].channel
        if (
            type(output) is not dict
            or set(output) != {"channel", "summary"}
            or type(output["channel"]) is not str
            or type(output["summary"]) is not str
            or output["channel"] != channel
        ):
            self._diagnostics.append({"code": "invalid_compressor_output"})
            return ""
        return output["summary"]

    def assert_exhausted(self) -> None:
        if self._completions:
            raise FixtureError(f"unused compress outputs: {len(self._completions)}")


class FixtureExecutor:
    def __init__(
        self,
        manifest: ExecutorManifest,
        controller: FixtureDispatchController,
        completions: Sequence[Mapping[str, Any]] | None = None,
    ) -> None:
        self.manifest = manifest
        self._controller = controller
        self._completions = None if completions is None else list(completions)

    async def dispatch(
        self,
        _op: str,
        _request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        self._controller.register(ctx)
        if self._completions is not None:
            if not self._completions:
                raise FixtureError(f"missing scripted {self.manifest.name} output")
            completion = self._completions.pop(0)
            if completion["delay"] > 0:
                await ctx.clock.sleep(completion["delay"])
            return completion["output"]  # type: ignore[no-any-return]
        await ctx.clock.sleep(math.inf)
        raise AssertionError("an infinite fixture dispatch resumed")

    def assert_exhausted(self) -> None:
        if self._completions:
            raise FixtureError(f"unused {self.manifest.name} outputs: {len(self._completions)}")


class FixtureDispatchController:
    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self.contexts: list[DispatchContext] = []

    def register(self, ctx: DispatchContext) -> None:
        self.contexts.append(ctx)

    async def emit(self, runtime: Runtime, stimulus: Mapping[str, Any]) -> None:
        dispatch_index = stimulus["dispatch_index"]
        for _ in range(1024):
            if dispatch_index < len(self.contexts):
                break
            await self._clock.sleep(0)
        else:
            raise FixtureError(f"unused executor stimulus plans: [{dispatch_index}]")
        ctx = self.contexts[dispatch_index]
        kind = stimulus["kind"]
        if kind == "executor_progress":
            assert ctx.progress is not None
            ctx.progress(
                ProgressPayload(
                    phase=stimulus["phase"],
                    internal_activity=stimulus["internal_activity"],
                    elapsed=stimulus["elapsed"],
                    summary=stimulus["summary"],
                )
            )
        elif kind == "executor_observation":
            assert ctx.observe is not None
            ctx.observe(
                ObservationPayload(
                    trust=stimulus["trust"],
                    content=dict(stimulus["content"]),
                    refs=tuple(stimulus["refs"]),
                )
            )
        elif kind == "executor_complete":
            delegate = ctx.delegate
            runtime.post(
                HandoffEvent(
                    channel=delegate.executor,
                    delegate_id=delegate.delegate_id,
                    origin_ref=delegate.origin_ref,
                    outcome=stimulus["outcome"],
                    trust=(
                        "untrusted_external"
                        if stimulus["trust"] == "untrusted_external"
                        else "trusted_system"
                    ),
                    content=dict(stimulus["content"]),
                    refs=tuple(stimulus["refs"]),
                )
            )


class ScriptedDelegateIds:
    def __init__(self, values: Sequence[str]) -> None:
        self._values = list(values)
        self._offset = 0

    def next(self) -> str:
        if self._offset >= len(self._values):
            raise FixtureError("scripted delegate id sequence exhausted")
        value = self._values[self._offset]
        self._offset += 1
        return value

    def assert_exhausted(self) -> None:
        remaining = len(self._values) - self._offset
        if remaining:
            raise FixtureError(f"unused delegate ids: {remaining}")


class FixtureRuntime(Runtime):
    def __init__(self, **options: Any) -> None:
        super().__init__(**options)
        self.recorded_floor_decisions: list[tuple[str, int, FloorDecision]] = []

    def _open_floor(self, utterance_id: str, priority: int) -> bool:
        decision = self.floor.decide(priority)
        self.recorded_floor_decisions.append((utterance_id, priority, decision))
        return super()._open_floor(utterance_id, priority)


def load_fixture(directory: Path) -> dict[str, Any]:
    fixture = {
        name: json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
        for name in ("manifest", "input", "expected")
    }
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(fixture)
    if fixture["manifest"]["id"] != directory.name:
        raise FixtureError("fixture manifest id must match its directory")
    _validate_timeline(fixture["input"])
    _validate_executor_plans(
        fixture["input"]["stimuli"],
        delegate_count=len(fixture["input"]["id_sequences"].get("delegate", ())),
    )
    return fixture


async def run_fixture(fixture: Mapping[str, Any]) -> dict[str, Any]:
    fixture_input = fixture["input"]
    initial_clock = fixture_input["initial_clock"]
    clock = VirtualClock(initial_clock)
    controller = FixtureDispatchController(clock)
    delegate_ids = ScriptedDelegateIds(fixture_input["id_sequences"].get("delegate", ()))
    playback_ids = ScriptedDelegateIds(fixture_input["id_sequences"].get("playback", ()))
    diagnostics: list[dict[str, Any]] = []
    outbound_desktop: list[dict[str, Any]] = []
    playback_effects: list[dict[str, Any]] = []
    model_views: list[dict[str, Any]] = []

    def on_frame(frame: PlaybackFrame) -> None:
        outbound_desktop.append(
            {
                "kind": "audio_frame",
                "data": {
                    "utterance_id": frame.utterance_id,
                    "generation_epoch": frame.generation_epoch,
                    "sequence": frame.sequence,
                    "pcm_base64": base64.b64encode(frame.pcm).decode("ascii"),
                },
            }
        )

    playback = PlaybackRegistry(
        id_factory=playback_ids.next,
        on_frame=on_frame,
        on_clear=lambda utterance_id, epoch: outbound_desktop.append(
            {
                "kind": "audio_clear",
                "data": {"utterance_id": utterance_id, "generation_epoch": epoch},
            }
        ),
        on_alert=lambda utterance_id, epoch: outbound_desktop.append(
            {
                "kind": "audio_alert",
                "data": {"utterance_id": utterance_id, "generation_epoch": epoch},
            }
        ),
    )
    fastbrain = ScriptedFastBrain(
        fixture_input["ports"]["fastbrain"],
        clock=clock,
        model_views=model_views,
    )
    surrogate = ScriptedSurrogate(
        fixture_input["ports"]["surrogate"],
        clock=clock,
        diagnostics=diagnostics,
        model_views=model_views,
    )
    compressor = ScriptedCompressor(
        fixture_input["ports"]["compressor"],
        clock=clock,
        diagnostics=diagnostics,
    )
    enabled = fixture_input["configuration"]["enabled_executors"]
    if len(enabled) != len(set(enabled)):
        raise FixtureError("enabled_executors must be unique")
    executor_scripts = fixture_input["ports"].get("executors", {})
    unexpected_scripts = sorted(set(executor_scripts) - set(enabled))
    if unexpected_scripts:
        raise FixtureError(f"scripted executor is not enabled: {unexpected_scripts[0]}")
    executors = {
        name: FixtureExecutor(
            _manifest_for(name),
            controller,
            executor_scripts.get(name),
        )
        for name in enabled
    }
    cooldown, fresh_window = PROACTIVITY[fixture_input["configuration"]["proactivity_preset"]]
    memory = Memory(policies=tuple(adapter.manifest.policy for adapter in executors.values()))
    sink = RecordingSink(clock)
    runtime = FixtureRuntime(
        clock=clock,
        memory=memory,
        fastbrain=fastbrain,
        surrogate=surrogate,
        compressor=compressor,
        executors=executors,
        expected_active_executors=frozenset(enabled),
        sink=sink,
        suggestion_cooldown=cooldown,
        fresh_window=fresh_window,
        delegate_id_factory=delegate_ids.next,
    )
    stimulus_groups: list[list[Mapping[str, Any]]] = []
    for stimulus in fixture_input["stimuli"]:
        if not stimulus_groups or stimulus_groups[-1][0]["at"] != stimulus["at"]:
            stimulus_groups.append([])
        stimulus_groups[-1].append(stimulus)
    ingress = [
        asyncio.create_task(
            _drive_stimulus_group(
                clock,
                runtime,
                controller,
                playback,
                playback_effects,
                group,
                initial_clock,
            )
        )
        for group in stimulus_groups
    ]
    await asyncio.sleep(0)
    await runtime.run()
    if ingress:
        await asyncio.gather(*ingress)

    fastbrain.assert_exhausted()
    surrogate.assert_exhausted()
    compressor.assert_exhausted()
    for adapter in executors.values():
        adapter.assert_exhausted()
    delegate_ids.assert_exhausted()
    playback_ids.assert_exhausted()
    effects = [
        {"kind": "dispatch", "delegate": _delegate_record(ctx.delegate)}
        for ctx in controller.contexts
    ]
    _assert_delegate_ids(fixture_input["id_sequences"], effects)
    actual = _snapshot(
        runtime,
        effects=effects,
        outbound_desktop=outbound_desktop,
        playback_effects=playback_effects,
        diagnostics=diagnostics,
        model_views=model_views,
    )
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate({**fixture, "expected": actual})
    return actual


def fixture_directories(root: Path = DEFAULT_FIXTURE_ROOT) -> list[Path]:
    return sorted(
        path for path in root.iterdir() if path.is_dir() and (path / "manifest.json").is_file()
    )


async def check_fixtures(directories: Sequence[Path]) -> list[str]:
    mismatches: list[str] = []
    for directory in directories:
        fixture = load_fixture(directory)
        actual = await run_fixture(fixture)
        if canonical_json(actual) != canonical_json(fixture["expected"]):
            mismatches.append(directory.name)
            print(_fixture_diff(directory.name, fixture["expected"], actual), file=sys.stderr)
    return mismatches


async def export_fixtures(directories: Sequence[Path]) -> None:
    for directory in directories:
        fixture = load_fixture(directory)
        actual = await run_fixture(fixture)
        target = directory / "expected.json"
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(
            _pretty_json(actual) + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)


def _snapshot(
    runtime: FixtureRuntime,
    *,
    effects: list[dict[str, Any]],
    outbound_desktop: list[dict[str, Any]],
    playback_effects: list[dict[str, Any]],
    diagnostics: list[dict[str, Any]],
    model_views: list[dict[str, Any]],
) -> dict[str, Any]:
    fast_done = [
        event for event in runtime.applied if isinstance(event, ModelDone) and event.slot == "fast"
    ]
    floor_decisions = []
    for utterance_id, priority, decision in runtime.recorded_floor_decisions:
        index = int(utterance_id.removeprefix("u-")) - 1
        floor_decisions.append(
            {"event_seq": fast_done[index].seq, "priority": priority, "decision": decision}
        )
    return _json_safe(
        {
            "schema_version": 1,
            "model_views": model_views,
            "applied_events": [to_record(event) for event in runtime.applied],
            "memory": {
                "channels": {
                    name: [asdict(item) for item in channel.items]
                    for name, channel in runtime.memory.channels.items()
                },
                "structured": asdict(runtime.memory.structured),
                "summaries": {
                    name: channel.summary for name, channel in runtime.memory.channels.items()
                },
            },
            "delegates": [_delegate_record(delegate) for delegate in runtime.delegates.snapshot()],
            "suggestions": [
                {
                    **asdict(suggestion),
                    "expires_at": (
                        suggestion.expires_at if math.isfinite(suggestion.expires_at) else None
                    ),
                }
                for suggestion in runtime.suggestions.all()
            ],
            "floor_decisions": floor_decisions,
            "outbound_desktop": outbound_desktop,
            "executor_effects": effects,
            **({"playback_effects": playback_effects} if playback_effects else {}),
            "diagnostics": diagnostics,
        }
    )


async def _drive_stimulus_group(
    clock: VirtualClock,
    runtime: Runtime,
    controller: FixtureDispatchController,
    playback: PlaybackRegistry,
    playback_effects: list[dict[str, Any]],
    stimuli: Sequence[Mapping[str, Any]],
    initial_clock: float,
) -> None:
    if not stimuli:
        return
    await clock.sleep(stimuli[0]["at"] - initial_clock)
    for stimulus in stimuli:
        kind = stimulus["kind"]
        if kind == "playback_open":
            generation = playback.open_response(
                session_epoch=stimulus["session_epoch"],
                response_id=stimulus["response_id"],
            )
            playback_effects.append({"kind": "open", "generation": asdict(generation)})
        elif kind == "playback_audio":
            pcm = _decode_fixture_pcm(stimulus["pcm_base64"])
            playback.push_audio(
                session_epoch=stimulus["session_epoch"],
                response_id=stimulus["response_id"],
                pcm=pcm,
            )
        elif kind == "playback_transcript":
            playback.set_transcript(
                session_epoch=stimulus["session_epoch"],
                response_id=stimulus["response_id"],
                text=stimulus["text"],
            )
        elif kind == "playback_terminal":
            playback.mark_provider_terminal(
                session_epoch=stimulus["session_epoch"],
                response_id=stimulus["response_id"],
                disposition=stimulus.get("disposition", "spoken"),
            )
        elif kind == "playback_start":
            accepted = playback.mark_started(stimulus["utterance_id"], stimulus["generation_epoch"])
            playback_effects.append(
                _playback_ack_effect(stimulus, ack="started", accepted=accepted)
            )
        elif kind == "playback_fence_current":
            playback.fence_current(alert=stimulus.get("alert", False))
        elif kind == "playback_cleared":
            completion = playback.record_cleared(
                stimulus["utterance_id"],
                stimulus["generation_epoch"],
                stimulus["played_ms"],
            )
            playback_effects.append(
                _playback_ack_effect(
                    stimulus,
                    ack="cleared",
                    accepted=completion is not None,
                    completion=completion,
                )
            )
        elif kind == "playback_done":
            completion = playback.ack_done(
                stimulus["utterance_id"],
                stimulus["generation_epoch"],
                stimulus.get("played_ms"),
            )
            playback_effects.append(
                _playback_ack_effect(
                    stimulus,
                    ack="done",
                    accepted=completion is not None,
                    completion=completion,
                )
            )
        elif kind == "floor_user_start":
            runtime.floor = runtime.floor.on_user_speak_start(stimulus["speech_id"])
        elif kind == "floor_user_end":
            runtime.floor = runtime.floor.on_user_speak_end(stimulus["speech_id"])
        elif kind == "floor_agent_start":
            runtime.floor = runtime.floor.on_speak_start(
                stimulus["utterance_id"], stimulus["priority"]
            )
        elif kind == "floor_agent_end":
            runtime.floor = runtime.floor.on_speak_end(stimulus["utterance_id"])
        elif kind == "user_input":
            runtime.post(
                UserInput(
                    text=stimulus["text"],
                    media_refs=tuple(stimulus.get("media_refs", ())),
                )
            )
        elif kind.startswith("executor_"):
            await controller.emit(runtime, stimulus)
        elif kind == "raw_progress":
            runtime.post(
                ProgressEvent(
                    channel=stimulus["channel"],
                    delegate_id=stimulus["delegate_id"],
                    op=stimulus["op"],
                    phase=stimulus["phase"],
                    internal_activity=stimulus["internal_activity"],
                    elapsed=stimulus["elapsed"],
                    summary=stimulus["summary"],
                )
            )
        elif kind == "raw_observation":
            runtime.post(
                ObservationEvent(
                    channel=stimulus["channel"],
                    delegate_id=stimulus["delegate_id"],
                    op=stimulus["op"],
                    origin_ref=stimulus["origin_ref"],
                    trust=stimulus["trust"],
                    content=dict(stimulus["content"]),
                    refs=tuple(stimulus["refs"]),
                )
            )
        elif kind == "advance_clock":
            await clock.sleep(stimulus["to"] - clock.now())
        await clock.sleep(0)


def _delegate_record(delegate: Delegate) -> dict[str, Any]:
    return {
        "executor": delegate.executor,
        "op": delegate.op,
        "request": dict(delegate.request),
        "origin_ref": delegate.origin_ref,
        "delegate_id": delegate.delegate_id,
        "deadline": delegate.deadline,
        "routing_class": delegate.routing_class,
        "dispatched_at": delegate.dispatched_at,
    }


def _decode_fixture_pcm(value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as problem:
        raise FixtureError("fixture PCM must use canonical non-empty base64") from problem
    if not decoded or base64.b64encode(decoded).decode("ascii") != value:
        raise FixtureError("fixture PCM must use canonical non-empty base64")
    return decoded


def _playback_ack_effect(
    stimulus: Mapping[str, Any],
    *,
    ack: str,
    accepted: bool,
    completion: object | None = None,
) -> dict[str, Any]:
    return {
        "kind": "ack",
        "ack": ack,
        "utterance_id": stimulus["utterance_id"],
        "generation_epoch": stimulus["generation_epoch"],
        "accepted": accepted,
        "completion": asdict(completion) if completion is not None else None,
    }


def _parse_fastbrain_output(
    output: Any,
) -> tuple[tuple[str, str], ActionOutput] | None:
    if type(output) is not dict or set(output) != {"speak", "action"}:
        return None
    speak = output["speak"]
    action = output["action"]
    if type(speak) is not dict or type(action) is not dict:
        return None
    speak_act = speak.get("act")
    if speak_act == "none" and set(speak) == {"act"}:
        parsed_speak = ("none", "")
    elif (
        speak_act in {"say", "ask"}
        and set(speak) == {"act", "text"}
        and type(speak.get("text")) is str
    ):
        parsed_speak = (speak_act, speak["text"])
    else:
        return None

    action_act = action.get("act")
    if action_act == "none" and set(action) == {"act"}:
        parsed_action = ActionOutput(act="none")
    elif action_act == "delegate" and set(action) == {"act", "delegate"}:
        delegate = action["delegate"]
        if (
            type(delegate) is not dict
            or set(delegate) != {"executor", "op", "request", "origin_ref"}
            or type(delegate["executor"]) is not str
            or not delegate["executor"]
            or type(delegate["op"]) is not str
            or not delegate["op"]
            or type(delegate["request"]) is not dict
            or not _is_finite_json_value(delegate["request"])
            or type(delegate["origin_ref"]) is not str
            or not delegate["origin_ref"]
        ):
            return None
        parsed_action = ActionOutput(
            act="delegate",
            delegate=DelegateRequest(
                executor=delegate["executor"],
                op=delegate["op"],
                request=dict(delegate["request"]),
                origin_ref=delegate["origin_ref"],
            ),
        )
    elif action_act == "update" and set(action) == {"act", "update"}:
        update = action["update"]
        if (
            type(update) is not dict
            or set(update) != {"target", "delta"}
            or type(update["target"]) is not str
            or not update["target"]
            or type(update["delta"]) is not dict
            or not _is_finite_json_value(update["delta"])
        ):
            return None
        parsed_action = ActionOutput(
            act="update",
            update=UpdateSpec(target=update["target"], delta=dict(update["delta"])),
        )
    else:
        return None
    return parsed_speak, parsed_action


def _is_finite_json_value(value: Any) -> bool:
    if value is None or type(value) in {bool, str}:
        return True
    if type(value) in {int, float}:
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    if type(value) is list:
        return all(_is_finite_json_value(item) for item in value)
    if type(value) is dict:
        return all(type(key) is str and _is_finite_json_value(item) for key, item in value.items())
    return False


def _valid_surrogate_output(output: Any) -> bool:
    if type(output) is not dict or not set(output) <= {"speak", "suggestion_id", "reason"}:
        return False
    return (
        type(output.get("speak")) is bool
        and (output.get("suggestion_id") is None or type(output.get("suggestion_id")) is str)
        and type(output.get("reason", "")) is str
    )


def _manifest_for(name: str) -> ExecutorManifest:
    if name != "slow_sim":
        raise FixtureError(f"fixture executor is not registered: {name}")
    return ExecutorManifest(
        name=name,
        policy=HandoffPolicy(
            channel=name,
            priority=50,
            wake="fast",
            typical_latency=5.0,
            compress_watermark=8,
            progress_via_surrogate=True,
        ),
        ops=(
            OpSpec(
                name="set_light",
                description="set light brightness",
                params={},
                deadline_budget=5.0,
            ),
            OpSpec(
                name="set_credential",
                description="exercise sensitive parameter handling",
                params={
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string"},
                        "token": {"type": "string"},
                    },
                    "required": ["mode", "token"],
                },
                sensitive_params=("token",),
                deadline_budget=5.0,
            ),
        ),
    )


def _validate_timeline(fixture_input: Mapping[str, Any]) -> None:
    current = fixture_input["initial_clock"]
    for index, stimulus in enumerate(fixture_input["stimuli"]):
        if stimulus["at"] < current:
            raise FixtureError(f"stimulus {index} moves backwards or crosses a clock advance")
        current = stimulus["at"]
        if stimulus["kind"] == "advance_clock":
            if stimulus["to"] <= current:
                raise FixtureError(f"clock advance {index} must strictly advance")
            current = stimulus["to"]


def _validate_executor_plans(stimuli: Sequence[Mapping[str, Any]], *, delegate_count: int) -> None:
    plans: dict[int, list[tuple[int, Mapping[str, Any]]]] = defaultdict(list)
    for index, stimulus in enumerate(stimuli):
        if stimulus["kind"].startswith("executor_"):
            plans[stimulus["dispatch_index"]].append((index, stimulus))
    for dispatch_index, plan in plans.items():
        if dispatch_index >= delegate_count:
            raise FixtureError(f"unused executor stimulus plans: [{dispatch_index}]")
        completions = [index for index, item in plan if item["kind"] == "executor_complete"]
        if len(completions) > 1:
            raise FixtureError(f"dispatch {dispatch_index} has multiple completions")
        if completions and completions[0] != plan[-1][0]:
            raise FixtureError(f"dispatch {dispatch_index} has stimuli after completion")


def _assert_delegate_ids(
    sequences: Mapping[str, Sequence[str]],
    effects: Sequence[Mapping[str, Any]],
) -> None:
    actual = [effect["delegate"]["delegate_id"] for effect in effects]
    expected = list(sequences.get("delegate", ()))
    if actual != expected:
        raise FixtureError(f"delegate id sequence differs: expected {expected}, got {actual}")
    unused = {
        name: list(values)
        for name, values in sequences.items()
        if name not in {"delegate", "playback"} and values
    }
    if unused:
        raise FixtureError(f"unused id sequences: {sorted(unused)}")


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_json_safe(item) for item in value]
    return value


def _pretty_json(value: Any, *, sort_keys: bool = False) -> str:
    rendered = json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        sort_keys=sort_keys,
        allow_nan=False,
    )
    return "".join(
        f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in rendered
    )


def _fixture_diff(identifier: str, expected: Any, actual: Any) -> str:
    expected_lines = _pretty_json(expected, sort_keys=True).splitlines()
    actual_lines = _pretty_json(actual, sort_keys=True).splitlines()
    return "\n".join(
        difflib.unified_diff(
            expected_lines,
            actual_lines,
            fromfile=f"{identifier}/expected.json",
            tofile=f"{identifier}/python-actual.json",
            lineterm="",
        )
    )


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    parser.add_argument("directories", nargs="*", type=Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    directories = args.directories or fixture_directories()
    if args.command == "export":
        asyncio.run(export_fixtures(directories))
        return 0
    mismatches = asyncio.run(check_fixtures(directories))
    if mismatches:
        print(f"Python fixture mismatches: {', '.join(mismatches)}", file=sys.stderr)
        return 1
    print(f"Python fixture parity passed: {len(directories)} scenario(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
