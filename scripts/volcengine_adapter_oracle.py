"""Export/check Python Volcengine cascaded-adapter behavioral fixtures.

The scenario document is hand-authored. The expected document is produced only through
``--export`` by driving the production :class:`VolcengineCascadedAdapter` with deterministic
endpointing, ASR, Ark, TTS, identity, and telemetry ports.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
from collections.abc import AsyncIterator, Mapping, Sequence
from copy import deepcopy
from dataclasses import asdict, is_dataclass
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.realtime.protocol import (  # noqa: E402
    HostContextItem,
    HostResponseIntent,
    RealtimeFrontBrainEvent,
)
from nova_audio_agent.realtime.volcengine.adapter import (  # noqa: E402
    VolcengineCascadedAdapter,
)
from nova_audio_agent.realtime.volcengine.ark import (  # noqa: E402
    ArkResponseCompleted,
    ArkResponseFailed,
    ArkResponseStarted,
    ArkTextDelta,
    ArkToolCall,
)
from nova_audio_agent.realtime.volcengine.asr import AsrTranscript  # noqa: E402
from nova_audio_agent.realtime.volcengine.tts import TtsAudio  # noqa: E402
from nova_audio_agent.realtime.volcengine.vad import VadEvent  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "volcengine" / "v1" / "adapter.json"
EXPECTED = FIXTURE.with_name("adapter-expected.json")
_SETTLE_SECONDS = 1.0
_FAILURE_SENTINEL = "sentinel-provider-secret"


class FixtureError(RuntimeError):
    """The hand-authored adapter scenario is malformed or internally inconsistent."""


class _Telemetry:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def record(self, kind: str, payload: dict[str, Any]) -> None:
        self.records.append({"name": kind, "payload": deepcopy(payload)})

    def close(self) -> None:
        raise AssertionError("the adapter must not close caller-owned telemetry")


class _ScriptedVad:
    def __init__(self, script: Sequence[Sequence[Mapping[str, Any]]]) -> None:
        self._script = [list(events) for events in script]
        self.in_speech = False
        self.calls = 0
        self.resets = 0

    def feed(self, pcm: bytes) -> tuple[VadEvent, ...]:
        if self.calls >= len(self._script):
            raise FixtureError("VAD feed script exhausted")
        entries = self._script[self.calls]
        self.calls += 1
        events: list[VadEvent] = []
        for entry in entries:
            kind = entry["kind"]
            if kind == "speech_started":
                self.in_speech = True
                pre_roll = (
                    pcm if entry.get("pre_roll") == "input" else _bytes(entry, "pre_roll_b64")
                )
                speech = pcm if entry.get("speech") == "input" else _bytes(entry, "speech_b64")
                events.append(VadEvent(kind, pre_roll_pcm=pre_roll, speech_pcm=speech))
            elif kind == "speech_stopped":
                self.in_speech = False
                events.append(
                    VadEvent(
                        kind,
                        speech_ms=float(entry.get("speech_ms", 500)),
                        commit=entry.get("commit", True) is True,
                        forced=entry.get("forced", False) is True,
                    )
                )
            else:
                raise FixtureError(f"unknown VAD event: {kind}")
        return tuple(events)

    def reset(self) -> None:
        self.in_speech = False
        self.resets += 1


class _ScriptedAsrSession:
    def __init__(
        self,
        *,
        label: str,
        spec: Mapping[str, Any],
        operations: list[dict[str, Any]],
    ) -> None:
        self._label = label
        self._spec = spec
        self._operations = operations
        self._append_calls = 0
        self._finished = asyncio.Event()

    async def append(self, pcm: bytes) -> None:
        self._append_calls += 1
        failed = self._append_calls == self._spec.get("append_error_at")
        self._operations.append(
            {
                "op": "append",
                "session": self._label,
                "pcm_b64": base64.b64encode(pcm).decode(),
                "outcome": "error" if failed else "ok",
            }
        )
        if failed:
            raise ConnectionError(_FAILURE_SENTINEL)

    async def finish(self) -> None:
        failed = self._spec.get("finish_error") is True
        self._operations.append(
            {"op": "finish", "session": self._label, "outcome": "error" if failed else "ok"}
        )
        if failed:
            raise ConnectionError(_FAILURE_SENTINEL)
        self._finished.set()

    async def events(self) -> AsyncIterator[AsrTranscript]:
        if self._spec.get("block_events") is True:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")
        await self._finished.wait()
        if self._spec.get("events_error") is True:
            raise ConnectionError(_FAILURE_SENTINEL)
        for transcript in self._spec.get("transcripts", []):
            yield AsrTranscript(transcript["text"], transcript["final"] is True)

    async def close(self) -> None:
        self._operations.append({"op": "close", "session": self._label})
        self._finished.set()


class _ScriptedAsr:
    def __init__(self, script: Sequence[Mapping[str, Any]]) -> None:
        self._script = list(script)
        self._opens = 0
        self.operations: list[dict[str, Any]] = []

    async def open(self) -> _ScriptedAsrSession:
        if self._opens >= len(self._script):
            raise FixtureError("ASR open script exhausted")
        index = self._opens
        self._opens += 1
        spec = self._script[index]
        label = f"asr-{index + 1}"
        failed = spec.get("open_error") is True
        self.operations.append(
            {"op": "open", "session": label, "outcome": "error" if failed else "ok"}
        )
        if failed:
            raise ConnectionError(_FAILURE_SENTINEL)
        return _ScriptedAsrSession(label=label, spec=spec, operations=self.operations)


class _ScriptedArk:
    def __init__(self, script: Sequence[Sequence[Mapping[str, Any]]]) -> None:
        self._script = [list(events) for events in script]
        self.calls: list[dict[str, Any]] = []

    async def stream(self, **kwargs: Any) -> AsyncIterator[Any]:
        index = len(self.calls)
        if index >= len(self._script):
            raise FixtureError("Ark stream script exhausted")
        self.calls.append(
            {
                "input_items": deepcopy(list(kwargs["input_items"])),
                "tools": deepcopy(list(kwargs["tools"])),
                "previous_response_id": kwargs["previous_response_id"],
            }
        )
        for entry in self._script[index]:
            kind = entry["kind"]
            if kind == "started":
                yield ArkResponseStarted(entry["response_id"])
            elif kind == "text":
                yield ArkTextDelta(entry["text"])
            elif kind == "tool":
                yield ArkToolCall(
                    entry["item_id"],
                    entry["call_id"],
                    entry["name"],
                    deepcopy(entry["arguments"]),
                )
            elif kind == "completed":
                yield ArkResponseCompleted(entry["response_id"])
            elif kind == "failed":
                yield ArkResponseFailed(entry["response_id"], entry.get("code", "failed"))
            elif kind == "yield":
                await asyncio.sleep(0)
            elif kind == "block":
                await asyncio.Event().wait()
            else:
                raise FixtureError(f"unknown Ark event: {kind}")


class _ScriptedTtsSession:
    def __init__(
        self,
        *,
        label: str,
        spec: Mapping[str, Any],
        operations: list[dict[str, Any]],
    ) -> None:
        self._label = label
        self._spec = spec
        self._operations = operations
        self._send_calls = 0
        self._finished = asyncio.Event()
        self._cancelled = False

    async def send_text(self, text: str) -> None:
        self._send_calls += 1
        failed = self._send_calls == self._spec.get("send_error_at")
        self._operations.append(
            {
                "op": "send_text",
                "session": self._label,
                "text": text,
                "outcome": "error" if failed else "ok",
            }
        )
        if failed:
            raise ConnectionError(_FAILURE_SENTINEL)
        await asyncio.sleep(0)

    async def finish(self) -> None:
        self._operations.append({"op": "finish", "session": self._label})
        self._finished.set()

    async def cancel(self) -> None:
        self._operations.append({"op": "cancel", "session": self._label})
        self._cancelled = True
        self._finished.set()

    async def events(self) -> AsyncIterator[TtsAudio]:
        for encoded in self._spec.get("audio_before_finish_b64", []):
            yield TtsAudio(base64.b64decode(encoded))
        if self._spec.get("events_error_after_audio") is True:
            raise ConnectionError(_FAILURE_SENTINEL)
        await self._finished.wait()
        if self._cancelled:
            return
        for encoded in self._spec.get("audio_b64", []):
            yield TtsAudio(base64.b64decode(encoded))

    async def close(self) -> None:
        self._operations.append({"op": "close", "session": self._label})
        self._finished.set()


class _ScriptedTts:
    def __init__(self, script: Sequence[Mapping[str, Any]]) -> None:
        self._script = list(script)
        self._opens = 0
        self.operations: list[dict[str, Any]] = []

    async def open(self) -> _ScriptedTtsSession:
        if self._opens >= len(self._script):
            raise FixtureError("TTS open script exhausted")
        index = self._opens
        self._opens += 1
        label = f"tts-{index + 1}"
        self.operations.append({"op": "open", "session": label})
        return _ScriptedTtsSession(
            label=label,
            spec=self._script[index],
            operations=self.operations,
        )


class _EventCollector:
    def __init__(self, adapter: VolcengineCascadedAdapter) -> None:
        self._adapter = adapter
        self._condition = asyncio.Condition()
        self.events: list[RealtimeFrontBrainEvent] = []
        self.task = asyncio.create_task(self._collect())

    async def _collect(self) -> None:
        async for event in self._adapter.events():
            async with self._condition:
                self.events.append(event)
                self._condition.notify_all()
        async with self._condition:
            self._condition.notify_all()

    async def wait(self, spec: Mapping[str, Any]) -> None:
        def satisfied() -> bool:
            return _matching_count(self.events, spec) >= int(spec.get("count", 1))

        async with self._condition:
            await asyncio.wait_for(self._condition.wait_for(satisfied), timeout=_SETTLE_SECONDS)


_EVENT_NAMES = {
    "UserSpeechStarted": "user_speech_started",
    "UserSpeechEnded": "user_speech_ended",
    "UserTranscriptDelta": "user_transcript_delta",
    "UserTranscriptFailed": "user_transcript_failed",
    "UserTranscriptFinal": "user_transcript_final",
    "ResponseStarted": "response_started",
    "ResponseAudioDelta": "response_audio_delta",
    "ResponseTranscriptDelta": "response_transcript_delta",
    "ResponseTranscriptFinal": "response_transcript_final",
    "ToolCallReady": "tool_call_ready",
    "ItemConfirmed": "item_confirmed",
    "ResponseTerminal": "response_terminal",
    "ResponseCancelRejected": "response_cancel_rejected",
    "ProviderErrorEvent": "provider_error",
}


def _event_name(event: RealtimeFrontBrainEvent) -> str:
    try:
        return _EVENT_NAMES[type(event).__name__]
    except KeyError as error:
        raise FixtureError(f"unknown provider event: {type(event).__name__}") from error


def _matching_count(events: Sequence[RealtimeFrontBrainEvent], spec: Mapping[str, Any]) -> int:
    count = 0
    for event in events:
        if _event_name(event) != spec["event"]:
            continue
        if "code" in spec and getattr(event, "code", None) != spec["code"]:
            continue
        count += 1
    return count


def _host_item(spec: Mapping[str, Any]) -> HostContextItem:
    return HostContextItem(
        kind=spec["kind"],
        host_item_id=spec["host_item_id"],
        event_id=spec["event_id"],
        content=spec["content"],
        call_id=spec.get("call_id"),
    )


def _intent(kind: str, item: HostContextItem) -> HostResponseIntent:
    if kind == "host_fact":
        return HostResponseIntent.host_fact(item)
    if kind == "tool_result":
        return HostResponseIntent.tool_result(item)
    raise FixtureError(f"unsupported response intent: {kind}")


async def _await_response_task(adapter: VolcengineCascadedAdapter) -> None:
    task = adapter._response_task  # noqa: SLF001 - oracle waits for the production operation
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=_SETTLE_SECONDS)


async def _run_scenario(spec: Mapping[str, Any], tools: Sequence[dict[str, Any]]) -> dict[str, Any]:
    vad = _ScriptedVad(spec.get("vad", []))
    asr = _ScriptedAsr(spec.get("asr", []))
    ark = _ScriptedArk(spec.get("ark", []))
    tts = _ScriptedTts(spec.get("tts", []))
    telemetry = _Telemetry()
    next_id = 0

    def id_factory() -> str:
        nonlocal next_id
        next_id += 1
        return f"{spec['name']}-id-{next_id}"

    adapter = VolcengineCascadedAdapter(
        vad=vad,
        asr=asr,
        ark=ark,
        tts=tts,
        telemetry=telemetry,
        id_factory=id_factory,
    )
    session = await adapter.connect(tools=tuple(deepcopy(tools)))
    collector = _EventCollector(adapter)
    items: dict[str, HostContextItem] = {}
    steps: list[dict[str, Any]] = []
    closed = False
    try:
        for index, step in enumerate(spec["steps"]):
            op = step["op"]
            result: Any = None
            try:
                if op == "send_audio":
                    pcm = base64.b64decode(step.get("pcm_b64", "AAE="))
                    await adapter.send_audio(pcm)
                elif op == "inject":
                    item = _host_item(step["item"])
                    identity = await adapter.inject_host_item(
                        item,
                        as_user_activation=step.get("as_user_activation", False) is True,
                    )
                    items[item.host_item_id] = item
                    result = asdict(identity)
                elif op == "create_response":
                    item = items[step["host_item_id"]]
                    await adapter.create_response(_intent(step["kind"], item))
                elif op == "cancel_response":
                    await adapter.cancel_response(step["response_id"])
                elif op == "close":
                    await adapter.close()
                    closed = True
                else:
                    raise FixtureError(f"unsupported adapter step: {op}")
            except FixtureError:
                raise
            except Exception as error:
                if step.get("expect_error") is not True:
                    raise
                result = {"error": type(error).__name__, "message": str(error)}
            if step.get("expect_error") is True and result is None:
                raise FixtureError(f"{spec['name']} step {index} expected an error")
            if "wait" in step:
                await collector.wait(step["wait"])
                if step["wait"]["event"] == "response_terminal":
                    await _await_response_task(adapter)
            steps.append({"step": index, "op": op, "result": result})
    finally:
        if not closed:
            await adapter.close()
        await asyncio.wait_for(collector.task, timeout=_SETTLE_SECONDS)

    return {
        "name": spec["name"],
        "session": asdict(session),
        "steps": steps,
        "events": [_normalize_event(event) for event in collector.events],
        "ark_calls": deepcopy(ark.calls),
        "asr_operations": deepcopy(asr.operations),
        "tts_operations": deepcopy(tts.operations),
        "telemetry": deepcopy(telemetry.records),
        "vad": {"feed_calls": vad.calls, "reset_calls": vad.resets},
        "state": {
            "pending_host_ids": list(adapter._pending_items),  # noqa: SLF001
            "consumed_host_ids": list(adapter._consumed_host_items),  # noqa: SLF001
            "abandoned_call_ids": list(adapter._abandoned_tool_call_ids),  # noqa: SLF001
            "previous_response_id": adapter._previous_response_id,  # noqa: SLF001
            "pending_tool_call_id": adapter._pending_tool_call_id,  # noqa: SLF001
        },
    }


def _normalize_event(event: RealtimeFrontBrainEvent) -> dict[str, Any]:
    if not is_dataclass(event):
        raise FixtureError("provider event is not a dataclass")
    payload = _plain(asdict(event))
    if "pcm" in payload:
        payload["pcm_b64"] = base64.b64encode(payload.pop("pcm")).decode()
    return {"event": _event_name(event), **payload}


def _plain(value: Any) -> Any:
    if isinstance(value, bytes):
        return value
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_plain(item) for item in value]
    return value


def _bytes(spec: Mapping[str, Any], field: str) -> bytes:
    encoded = spec.get(field)
    return b"" if encoded is None else base64.b64decode(encoded)


async def _produce(document: Mapping[str, Any]) -> dict[str, Any]:
    if document.get("schema_version") != 1:
        raise FixtureError("unknown adapter fixture schema version")
    scenarios = document.get("scenarios")
    tools = document.get("tools")
    if type(scenarios) is not list or type(tools) is not list:
        raise FixtureError("adapter fixture requires scenario and tool arrays")
    names = [scenario["name"] for scenario in scenarios]
    if len(names) != len(set(names)):
        raise FixtureError("adapter scenario names must be unique")
    return {
        "schema_version": 1,
        "scenarios": [await _run_scenario(scenario, tools) for scenario in scenarios],
    }


def produce(document: Mapping[str, Any]) -> dict[str, Any]:
    return asyncio.run(_produce(document))


def _render(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    ).encode()


def _write_export(rendered: bytes) -> None:
    descriptor, raw_path = tempfile.mkstemp(
        prefix="adapter-expected-", suffix=".tmp", dir=EXPECTED.parent
    )
    temporary = Path(raw_path)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(EXPECTED)
    finally:
        temporary.unlink(missing_ok=True)


def _matches_temporary(rendered: bytes) -> bool:
    descriptor, raw_path = tempfile.mkstemp(
        prefix="adapter-check-", suffix=".tmp", dir=EXPECTED.parent
    )
    temporary = Path(raw_path)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(rendered)
        return EXPECTED.is_file() and EXPECTED.read_bytes() == temporary.read_bytes()
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--export", action="store_true")
    arguments = parser.parse_args(argv)
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    rendered = _render(produce(document))
    if arguments.export:
        _write_export(rendered)
        print(f"exported {len(document['scenarios'])} Volcengine adapter scenarios")
        return 0
    if not _matches_temporary(rendered):
        print("Python Volcengine adapter does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python Volcengine adapter parity passed: {len(document['scenarios'])} scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
