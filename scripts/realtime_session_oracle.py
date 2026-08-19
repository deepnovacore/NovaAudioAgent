"""Python behavioral oracle for the realtime session provider-frame fixtures.

Normal checks are read-only. Updating ``expected.json`` requires the explicit ``export`` command
so behavioral golden changes stay visible in review.

    uv run python scripts/realtime_session_oracle.py check
    uv run python scripts/realtime_session_oracle.py export

Scenarios are sequences of normalized provider events and host actions; the golden is, per step,
what the session returned, the calls it made on the provider, the playback effects it produced,
and the state a caller can observe afterwards. The session is driven directly rather than through
a provider session, because that layer already drops events whose epoch does not match and a
fixture routed through it could never reach the session's own epoch guard.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import difflib
import io
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.clock import VirtualClock  # noqa: E402
from nova_audio_agent.realtime.history import RecoveryTurn  # noqa: E402
from nova_audio_agent.realtime.playback import (  # noqa: E402
    PlaybackCompletion,
    PlaybackFrame,
    PlaybackGeneration,
    PlaybackRegistry,
)
from nova_audio_agent.realtime.protocol import (  # noqa: E402
    HostContextItem,
    HostResponseIntent,
    ItemConfirmed,
    ItemIdentity,
    ProviderErrorEvent,
    ResponseAudioDelta,
    ResponseCancelRejected,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptDelta,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptDelta,
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.session import RealtimeSession  # noqa: E402

FIXTURE_ROOT = REPOSITORY_ROOT / "fixtures" / "realtime" / "session" / "v1"
SCHEMA_PATH = FIXTURE_ROOT / "schema.json"


class FixtureError(RuntimeError):
    """A fixture is malformed, or the run did not consume it as declared."""


class IdSequence:
    """The one host-allocated id sequence, shared by the session and the playback registry.

    Production shares a single factory between them, so the interleaving is part of what a fixture
    pins. Asking past the end, or leaving ids unconsumed, means the two runtimes disagree about how
    much they allocate -- which is exactly the kind of drift a golden should catch, so both are
    errors rather than tolerated slack.
    """

    def __init__(self, values: Sequence[str]) -> None:
        self._values = list(values)
        self._index = 0

    def __call__(self) -> str:
        if self._index >= len(self._values):
            raise FixtureError(
                f"id sequence exhausted after {self._index} id(s); declare more in input.ids"
            )
        value = self._values[self._index]
        self._index += 1
        return value

    @property
    def consumed(self) -> list[str]:
        return self._values[: self._index]

    def require_exhausted(self) -> None:
        if self._index != len(self._values):
            remaining = self._values[self._index :]
            raise FixtureError(f"id sequence left {len(remaining)} unconsumed: {remaining}")


class RecordingProvider:
    """A ``RealtimeFrontBrain`` that records every call instead of talking to a provider.

    Its ``events()`` is never used: the fixture feeds ``session.accept`` directly, one event per
    step, which is what lets a scenario stage an ordering a real socket would not reliably produce.
    """

    def __init__(self, actions: list[str]) -> None:
        self.actions = actions
        self.epoch = 0

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        self.epoch += 1
        self.actions.append(f"connect:{len(tools)}")
        return SessionIdentity(epoch=self.epoch, provider_session_id=f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        self.actions.append(f"audio:{len(pcm)}")

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        detail = "" if confirmation_timeout is None else f":timeout={confirmation_timeout!r}"
        activation = ":activation" if as_user_activation else ""
        self.actions.append(f"inject:{item.host_item_id}{detail}{activation}")
        return ItemIdentity(
            session_epoch=self.epoch,
            host_item_id=item.host_item_id,
            provider_item_id=f"provider-{item.host_item_id}",
        )

    async def create_response(self, intent: HostResponseIntent) -> None:
        spoken = ":origin_spoken" if intent.origin_spoken else ""
        self.actions.append(f"create_response:{intent.kind}{spoken}")

    async def cancel_response(self, response_id: str) -> None:
        self.actions.append(f"cancel:{response_id}")

    def events(self) -> Any:
        raise NotImplementedError("fixtures feed session.accept directly")

    async def close(self) -> None:
        self.actions.append("close")


# ---------------------------------------------------------------------------
# input -> objects
# ---------------------------------------------------------------------------


def _pcm(spec: Mapping[str, Any]) -> bytes:
    if "pcm_base64" in spec:
        return base64.b64decode(spec["pcm_base64"], validate=True)
    fill = spec["pcm_fill"]
    return bytes([fill["byte"]]) * fill["length"]


_EVENT_TYPES = {
    "user_speech_started": UserSpeechStarted,
    "user_speech_ended": UserSpeechEnded,
    "user_transcript_delta": UserTranscriptDelta,
    "user_transcript_final": UserTranscriptFinal,
    "user_transcript_failed": UserTranscriptFailed,
    "response_started": ResponseStarted,
    "response_transcript_delta": ResponseTranscriptDelta,
    "response_transcript_final": ResponseTranscriptFinal,
    "tool_call_ready": ToolCallReady,
    "item_confirmed": ItemConfirmed,
    "response_terminal": ResponseTerminal,
    "response_cancel_rejected": ResponseCancelRejected,
    "provider_error": ProviderErrorEvent,
}


def _build_event(spec: Mapping[str, Any]) -> Any:
    fields = {key: value for key, value in spec.items() if key != "kind"}
    kind = spec["kind"]
    if kind == "response_audio_delta":
        return ResponseAudioDelta(
            session_epoch=fields["session_epoch"],
            response_id=fields["response_id"],
            pcm=_pcm(fields["pcm"]),
        )
    if kind == "provider_error":
        return ProviderErrorEvent(
            session_epoch=fields["session_epoch"],
            code=fields["code"],
            recoverable=fields["recoverable"],
        )
    return _EVENT_TYPES[kind](**fields)


def _build_item(spec: Mapping[str, Any]) -> HostContextItem:
    return HostContextItem(
        kind=spec["kind"],
        host_item_id=spec["host_item_id"],
        event_id=spec["event_id"],
        content=spec["content"],
        call_id=spec["call_id"],
    )


def _build_intent(spec: Mapping[str, Any]) -> HostResponseIntent:
    return HostResponseIntent(
        kind=spec["kind"],
        item=_build_item(spec["item"]),
        task_summary=spec["task_summary"],
        origin_spoken=spec["origin_spoken"],
    )


# ---------------------------------------------------------------------------
# objects -> golden
# ---------------------------------------------------------------------------


def _generation_record(generation: PlaybackGeneration | None) -> dict[str, Any] | None:
    if generation is None:
        return None
    return {
        "session_epoch": generation.session_epoch,
        "generation_epoch": generation.generation_epoch,
        "generation_id": generation.generation_id,
        "utterance_id": generation.utterance_id,
        "response_id": generation.response_id,
    }


def _frame_record(frame: PlaybackFrame) -> dict[str, Any]:
    return {
        "utterance_id": frame.utterance_id,
        "generation_epoch": frame.generation_epoch,
        "sequence": frame.sequence,
        "pcm_base64": base64.b64encode(frame.pcm).decode("ascii"),
    }


def _completion_record(completion: PlaybackCompletion) -> dict[str, Any]:
    return {
        "session_epoch": completion.session_epoch,
        "response_id": completion.response_id,
        "utterance_id": completion.utterance_id,
        "generation_epoch": completion.generation_epoch,
        "text": completion.text,
        "disposition": completion.disposition,
        "started": completion.started,
        "played_ms": completion.played_ms,
    }


def _result_record(value: Any) -> Any:
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, PlaybackCompletion):
        return _completion_record(value)
    if hasattr(value, "accepted"):
        return {"accepted": value.accepted, "injection_epoch": value.injection_epoch}
    if hasattr(value, "role"):
        return {"role": value.role, "text": value.text, "final": value.final}
    raise FixtureError(f"unserializable step result: {value!r}")


def _observed_state(
    session: RealtimeSession,
    *,
    clock: VirtualClock,
    response_ids: Sequence[str],
    event_ids: Sequence[str],
) -> dict[str, Any]:
    return {
        # A hold deadline is relative to the clock, so the clock is part of the observation.
        "clock": clock.now(),
        "session_epoch": session.session_epoch,
        "user_input_revision": session.user_input_revision,
        "active_provider_response_id": session.active_provider_response_id,
        "provider_idle": session.provider_idle,
        "foreground_idle": session.foreground_idle,
        "current_generation": _generation_record(session.current_generation),
        "floor_state": session.floor.state,
        "user_caption": session._user_caption_text,
        "assistant_caption": session._assistant_caption_text,
        "responses": {
            response_id: {
                "phase": session.provider_turn_phase(response_id),
                "was_fenced": session.provider_turn_was_fenced(response_id),
                "user_input_revision": session.provider_turn_user_input_revision(response_id),
                "has_spoken": session.response_has_spoken(response_id),
                "event_ids": list(session.response_event_ids(response_id)),
            }
            for response_id in response_ids
        },
        "host_events_deduplicated": [
            event_id for event_id in event_ids if session.host_event_is_deduplicated(event_id)
        ],
        "snapshot": _snapshot_record(session),
    }


def _snapshot_record(session: RealtimeSession) -> dict[str, Any]:
    snapshot = session.snapshot()
    return {
        "version": snapshot.version,
        "active_delegates": [
            [
                delegate_id,
                {
                    "summary": record.summary,
                    "state": record.state,
                    "channel": record.channel,
                    "progress_summary": record.progress_summary,
                    "internal_activity": record.internal_activity,
                    "elapsed": record.elapsed,
                },
            ]
            for delegate_id, record in snapshot.active_delegates
        ],
        "spoken_event_ids": list(snapshot.spoken_event_ids),
        "interrupted_event_ids": list(snapshot.interrupted_event_ids),
    }


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------


def _mentioned_ids(steps: Sequence[Mapping[str, Any]]) -> tuple[list[str], list[str]]:
    """Every response id and host event id the scenario names, so an absent turn is still reported.

    Reporting a fixed key set each step means a turn that should not exist shows up as a null
    phase rather than as a missing key, which a canonical comparison would otherwise let through
    as a shape difference in only one direction.
    """
    responses: dict[str, None] = {}
    events: dict[str, None] = {}

    def note_intent(intent: Mapping[str, Any]) -> None:
        events[intent["item"]["event_id"]] = None

    for step in steps:
        event = step.get("event")
        if isinstance(event, Mapping) and isinstance(event.get("response_id"), str):
            responses[event["response_id"]] = None
        for key in ("item",):
            item = step.get(key)
            if isinstance(item, Mapping):
                events[item["event_id"]] = None
        intent = step.get("intent")
        if isinstance(intent, Mapping):
            note_intent(intent)
        for intent in step.get("intents", ()) or ():
            note_intent(intent)
    return sorted(responses), sorted(events)


async def _apply_step(
    session: RealtimeSession,
    step: Mapping[str, Any],
    clock: VirtualClock,
) -> Any:
    kind = step["kind"]
    if kind == "connect":
        return await session.connect(tools=_tools(step["tools"]))
    if kind == "reconnect":
        return await session.reconnect(tools=_tools(step["tools"]))
    if kind == "provider_event":
        return await session.accept(_build_event(step["event"]))
    if kind == "caption_for":
        return session.caption_for(_build_event(step["event"]), accepted=step["accepted"])
    if kind == "deliver_host_item":
        return await session.deliver_host_item(_build_item(step["item"]))
    if kind == "deliver_host_response":
        return await session.deliver_host_response(
            _build_intent(step["intent"]),
            as_user_activation=step["as_user_activation"],
        )
    if kind == "deliver_preemptive_host_response":
        return await session.deliver_preemptive_host_response(
            _build_intent(step["intent"]),
            confirmation_timeout=step["confirmation_timeout"],
            as_user_activation=step["as_user_activation"],
        )
    if kind == "inject_tool_output":
        return await session.inject_tool_output(_build_item(step["item"]))
    if kind == "request_tool_continuation":
        return await session.request_tool_continuation(
            tuple(_build_intent(intent) for intent in step["intents"]),
            origin_spoken=step["origin_spoken"],
        )
    if kind == "arm_next_response_fence":
        return session.arm_next_response_fence()
    if kind == "local_speech_onset":
        return await session.local_speech_onset(step["speech_id"])
    if kind == "host_preempt":
        return await session.host_preempt()
    if kind == "playback_started":
        return session.playback_started(step["utterance_id"], step["generation_epoch"])
    if kind == "playback_done":
        return session.playback_done(
            step["utterance_id"], step["generation_epoch"], step["played_ms"]
        )
    if kind == "complete_playback":
        return session.complete_playback(
            step["utterance_id"], step["generation_epoch"], step["played_ms"]
        )
    if kind == "playback_cleared":
        return session.playback_cleared(
            step["utterance_id"], step["generation_epoch"], step["played_ms"]
        )
    if kind == "playback_stopped":
        return await session.playback_stopped(
            step["utterance_id"], step["generation_epoch"], step["played_ms"]
        )
    if kind == "reconnect_for_guard":
        generation = session.current_generation
        if generation is None:
            raise FixtureError("reconnect_for_guard needs a generation to retain")
        return await session.reconnect_for_guard(
            tools=_tools(step["tools"]),
            old_generation=generation,
            confirmation_timeout=step["confirmation_timeout"],
            history=tuple(_build_recovery_turn(turn) for turn in step["history"]),
            history_mode=step["history_mode"],
        )
    if kind == "advance_clock":
        clock.advance_to(step["to"])
        return None
    if kind == "release_stale_user_hold":
        return session.release_stale_user_hold(step["max_hold_s"])
    if kind == "reset_captions":
        return session.reset_captions()
    raise FixtureError(f"unsupported step kind: {kind}")


def _build_recovery_turn(spec: Mapping[str, Any]) -> RecoveryTurn:
    return RecoveryTurn(
        sequence=spec["sequence"],
        role=spec["role"],
        text=spec["text"],
        delivery=spec["delivery"],
        played_ms=spec["played_ms"],
        trust=spec["trust"],
        source=spec["source"],
    )


def _tools(count: int) -> tuple[dict[str, object], ...]:
    return tuple({"name": f"tool-{index}"} for index in range(count))


async def run_fixture(fixture: Mapping[str, Any]) -> dict[str, Any]:
    steps = fixture["input"]["steps"]
    response_ids, event_ids = _mentioned_ids(steps)
    ids = IdSequence(fixture["input"]["ids"])

    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    alerts: list[tuple[str | None, int | None]] = []
    deliveries: list[PlaybackCompletion] = []
    spoken: list[str] = []

    playback = PlaybackRegistry(
        id_factory=ids,
        on_frame=frames.append,
        on_clear=lambda utterance_id, generation_epoch: actions.append(
            f"clear:{utterance_id}:{generation_epoch}"
        ),
        on_alert=lambda utterance_id, generation_epoch: alerts.append(
            (utterance_id, generation_epoch)
        ),
    )
    provider = RecordingProvider(actions)
    clock = VirtualClock()

    def record_delivery(completion: PlaybackCompletion) -> None:
        deliveries.append(completion)

    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=ids,
        on_spoken=spoken.append,
        on_delivery=record_delivery,
        clock=clock,
    )

    observations: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        marks = (len(actions), len(frames), len(alerts), len(deliveries), len(spoken))
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            result = await _apply_step(session, step, clock)
        # Reading the fence interruption clears it, but nothing else in the session ever reads
        # that field, so taking it once per step costs no fidelity and covers every path that
        # sets it.
        interruption = session.take_fence_interruption()
        observations.append(
            {
                "step": index,
                "kind": step["kind"],
                "result": _result_record(result),
                "actions": actions[marks[0] :],
                "frames": [_frame_record(frame) for frame in frames[marks[1] :]],
                "alerts": [list(alert) for alert in alerts[marks[2] :]],
                "deliveries": [
                    _completion_record(completion) for completion in deliveries[marks[3] :]
                ],
                "spoken": spoken[marks[4] :],
                "diagnostics": [
                    line
                    for line in captured.getvalue().splitlines()
                    if line.startswith("[realtime-diagnostic]")
                ],
                "fence_interruption": None
                if interruption is None
                else {
                    "session_epoch": interruption.session_epoch,
                    "event_ids": list(interruption.event_ids),
                },
                "state": _observed_state(
                    session,
                    clock=clock,
                    response_ids=response_ids,
                    event_ids=event_ids,
                ),
            }
        )

    ids.require_exhausted()
    return {"schema_version": 1, "observations": observations}


# ---------------------------------------------------------------------------
# fixture I/O
# ---------------------------------------------------------------------------


def fixture_directories(root: Path = FIXTURE_ROOT) -> list[Path]:
    """Every scenario directory, refusing to skip one that is merely missing its manifest.

    The Node leg enumerates the same directories and fails on one it cannot load, so skipping here
    would let a half-authored scenario be checked by neither leg while both builds stayed green.
    """
    directories = sorted(path for path in root.iterdir() if path.is_dir())
    unloadable = [path.name for path in directories if not (path / "manifest.json").is_file()]
    if unloadable:
        raise FixtureError(f"scenario directories without a manifest: {', '.join(unloadable)}")
    return directories


def _schema(*halves: str) -> dict[str, Any]:
    """The committed schema, narrowed to the halves a caller actually has.

    The first export of a scenario has no golden yet, but its manifest and input must still be
    validated: a typo that only `check` would catch could otherwise be exported first and then read
    as a behavior change. Narrowing the one committed schema keeps a single source of truth rather
    than a second, laxer one for the export path.
    """
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return {
        "$schema": schema["$schema"],
        "type": "object",
        "properties": {half: schema["properties"][half] for half in halves},
        "required": list(halves),
        "additionalProperties": False,
    }


def _validate(fixture: Mapping[str, Any], directory: Path, *halves: str) -> None:
    errors = sorted(
        Draft202012Validator(_schema(*halves)).iter_errors(fixture),
        key=lambda error: list(error.absolute_path),
    )
    if errors:
        rendered = "; ".join(
            f"{'/'.join(str(part) for part in error.absolute_path) or '<root>'}: {error.message}"
            for error in errors[:5]
        )
        raise FixtureError(f"{directory.name} does not match the committed schema -- {rendered}")
    if fixture["manifest"]["id"] != directory.name:
        raise FixtureError("fixture manifest id must match its directory")
    _validate_requires(fixture)


def load_fixture(directory: Path) -> dict[str, Any]:
    if not (directory / "expected.json").is_file():
        raise FixtureError(f"{directory.name} has no golden; run export for it first")
    fixture = {
        name: json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
        for name in ("manifest", "input", "expected")
    }
    _validate(fixture, directory, "manifest", "input", "expected")
    return fixture


def load_input(directory: Path) -> dict[str, Any]:
    """Load a fixture whose golden does not exist yet, for the first export."""
    fixture = {
        name: json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
        for name in ("manifest", "input")
    }
    _validate(fixture, directory, "manifest", "input")
    return fixture


def _validate_requires(fixture: Mapping[str, Any]) -> None:
    declared = set(fixture["manifest"]["requires"])
    uses_fill = any(
        "pcm_fill" in (step.get("event", {}) or {}).get("pcm", {})
        for step in fixture["input"]["steps"]
    )
    if uses_fill and "pcm_fixture" not in declared:
        raise FixtureError('a scenario using pcm_fill must declare requires: ["pcm_fixture"]')
    if "pcm_fixture" in declared and not uses_fill:
        raise FixtureError("requires pcm_fixture but no step uses pcm_fill")


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
    """Rewrite every golden from a fresh run.

    Only the manifest and input are validated. Validating the existing golden would deadlock the
    one case export exists for: a contract that gained a field leaves every committed golden
    invalid, and the command that regenerates them must not be blocked by the files it is about to
    replace. The rewritten goldens are validated by the next `check`.
    """
    for directory in directories:
        fixture = load_input(directory)
        actual = await run_fixture(fixture)
        target = directory / "expected.json"
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(_pretty_json(actual) + "\n", encoding="utf-8")
        temporary.replace(target)


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
    return "\n".join(
        difflib.unified_diff(
            _pretty_json(expected, sort_keys=True).splitlines(),
            _pretty_json(actual, sort_keys=True).splitlines(),
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
    # Take an explicit argv so an embedding test runner's own arguments cannot leak in.
    args = _parse_args(argv)
    try:
        directories = args.directories or fixture_directories()
        if not directories:
            print("no session fixtures found", file=sys.stderr)
            return 1
        if args.command == "export":
            asyncio.run(export_fixtures(directories))
            print(f"exported {len(directories)} scenario(s)")
            return 0
        mismatches = asyncio.run(check_fixtures(directories))
    except FixtureError as error:
        print(f"malformed fixture: {error}", file=sys.stderr)
        return 1
    if mismatches:
        print(f"Python session fixture mismatches: {', '.join(mismatches)}", file=sys.stderr)
        return 1
    print(f"Python realtime session parity passed: {len(directories)} scenario(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
