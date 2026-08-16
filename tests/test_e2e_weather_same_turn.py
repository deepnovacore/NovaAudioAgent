"""Deterministic CI backend for the `qwen-weather-same-turn.v1` scenario.

Everything below the provider boundary is production code: the real ``Runtime``
(VirtualClock), the real ``SearchAdapter``, the real ``RealtimeRuntimeBridge``,
``RealtimeSession``, and ``RealtimeService``. Only the realtime provider and the
Tavily transport are scripted, which is exactly the nondeterminism the design doc
allows CI to replace.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from itertools import count
from typing import Any

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.evals.weather_same_turn import (
    SCENARIO_ID,
    USER_TURN,
    Finding,
    ScenarioRecorder,
    ScenarioReport,
    build_report_mapping,
    evaluate_weather_same_turn,
)
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST
from nova_audio_agent.executors.search import SEARCH_MANIFEST, SearchAdapter
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.ports import DispatchContext, Handoff
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge, ToolAcceptance
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame, PlaybackRegistry
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptDelta,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
)
from nova_audio_agent.realtime.service import RealtimeService
from nova_audio_agent.realtime.session import CaptionFrame, RealtimeSession
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema
from scripts.eval_weather_same_turn import LiveRecording

SEARCH_QUERY = "北京 实时天气 气温"
ORIGIN_RESPONSE_ID = "origin-1"
SEARCH_CALL_ID = "call-search"
ANSWER_TEXT = "北京现在是晴天，气温二十五摄氏度左右，出门穿件薄外套就行。"

#: The design doc's fixed CI result.
FIXED_RESULTS = (
    {
        "title": "北京当前天气",
        "content": "北京当前晴，气温二十五摄氏度。",
        "url": "https://weather.example.test/beijing",
    },
)

#: Same input shape as
#: ``tests/test_realtime_service.py::test_sync_result_content_stays_valid_json_at_max_legal_input``.
MAX_LEGAL_QUERY = "北京天气" + "天" * 508
MAX_LEGAL_RESULTS = tuple(
    {
        "title": "标" * 300,
        "content": "摘" * 2000,
        "url": f"https://example{index}.test/very/long/path",
    }
    for index in range(5)
)


class WeatherTransport:
    """Scripted Tavily transport: no network, one fixed normalized payload."""

    def __init__(self, results: tuple[Mapping[str, Any], ...] = FIXED_RESULTS) -> None:
        self._results = results
        self.queries: list[tuple[str, int]] = []

    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        self.queries.append((query, max_results))
        return {
            "request_id": "req-weather-1",
            "results": [dict(result) for result in self._results[:max_results]],
        }


class UnusedCodexAdapter:
    """Satisfies D19 executor cardinality; this scenario must never route to codex."""

    manifest = CODEX_LIVE_MANIFEST

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        raise AssertionError(f"qwen-weather-same-turn must never dispatch codex.{op}")


class ScriptedProvider:
    """Realtime provider stand-in that records the provider-side protocol facts."""

    def __init__(self, recorder: ScenarioRecorder) -> None:
        self.epoch = 0
        self._recorder = recorder
        self.injected: list[HostContextItem] = []
        self.response_intents: list[HostResponseIntent] = []
        self.continuation_ids: list[str] = []
        self.connected_tool_names: tuple[str, ...] = ()

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        self.epoch += 1
        self.connected_tool_names = tuple(
            str(schema.get("function", {}).get("name"))  # type: ignore[union-attr]
            for schema in tools
        )
        return SessionIdentity(self.epoch, f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        return None

    async def inject_host_item(self, item: HostContextItem) -> ItemIdentity:
        self.injected.append(item)
        if item.kind == "tool_output" and item.call_id is not None:
            self._recorder.record(
                "tool.output",
                {"call_id": item.call_id, "content": item.content},
            )
        return ItemIdentity(self.epoch, item.host_item_id, f"provider-{item.host_item_id}")

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.response_intents.append(intent)
        response_id = f"continuation-{len(self.continuation_ids) + 1}"
        self.continuation_ids.append(response_id)
        self._recorder.record("continuation.created", {"response_id": response_id})

    async def cancel_response(self, response_id: str) -> None:
        return None

    async def close(self) -> None:
        return None

    async def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        if False:  # pragma: no cover - the receive loop is never started here
            yield ResponseStarted(session_epoch=1, response_id="unused")


class RecordingBridge:
    """Forward every call to the real bridge, recording only the scenario allowlist."""

    def __init__(self, inner: RealtimeRuntimeBridge, recorder: ScenarioRecorder) -> None:
        self._inner = inner
        self._recorder = recorder

    async def accept_user_transcript(self, text: str) -> object:
        return await self._inner.accept_user_transcript(text)

    async def accept_tool_call(
        self,
        call: ToolCallReady,
        *,
        origin_ref: str | None = None,
    ) -> ToolAcceptance:
        self._recorder.record(
            "tool.call",
            {
                "call_id": call.call_id,
                "name": call.name,
                "query": call.arguments.get("query"),
                "k": call.arguments.get("k"),
            },
        )
        acceptance = await self._inner.accept_tool_call(call, origin_ref=origin_ref)
        try:
            state = json.loads(acceptance.host_item.content).get("state")
        except json.JSONDecodeError:  # pragma: no cover - the bridge always emits JSON
            state = None
        self._recorder.record(
            "tool.accepted",
            {
                "call_id": call.call_id,
                "delegate_id": acceptance.delegate_id,
                "sync_result": acceptance.sync_result,
                "state": state,
                "code": acceptance.code,
            },
        )
        return acceptance


@dataclass(slots=True)
class ScenarioRun:
    recorder: ScenarioRecorder
    provider: ScriptedProvider
    service: RealtimeService
    runtime: Runtime
    clock: VirtualClock
    transport: WeatherTransport
    frames: list[PlaybackFrame]

    @property
    def records(self) -> tuple[Mapping[str, Any], ...]:
        return self.recorder.records


def _build_stack(transport: WeatherTransport) -> tuple[ScenarioRun, RealtimeService]:
    clock = VirtualClock()
    recorder = ScenarioRecorder(clock=clock)
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy, SEARCH_MANIFEST.policy))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": USER_TURN},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={"codex": UnusedCodexAdapter(), "search": SearchAdapter(transport)},
    )
    tools = compile_tool_schema((CODEX_LIVE_MANIFEST, SEARCH_MANIFEST))
    identifiers = count(1)
    next_id = lambda: f"nova-{next(identifiers)}"  # noqa: E731 - one-line id factory
    provider = ScriptedProvider(recorder)
    frames: list[PlaybackFrame] = []
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=frames.append,
        on_clear=lambda utterance_id, epoch: None,
    )
    session = RealtimeSession(
        provider=provider,  # type: ignore[arg-type]
        playback=playback,
        id_factory=next_id,
        clock=clock,
    )
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=next_id)

    def on_caption(frame: CaptionFrame) -> None:
        if frame.role == "assistant" and frame.final:
            recorder.record("answer.transcript", {"text": frame.text})

    service = RealtimeService(
        provider=provider,  # type: ignore[arg-type]
        runtime=runtime,
        tools=tools,
        session=session,
        bridge=RecordingBridge(bridge, recorder),  # type: ignore[arg-type]
        id_factory=next_id,
        on_caption=on_caption,
    )
    run = ScenarioRun(
        recorder=recorder,
        provider=provider,
        service=service,
        runtime=runtime,
        clock=clock,
        transport=transport,
        frames=frames,
    )
    return run, service


async def drive_scenario(
    *,
    transport: WeatherTransport | None = None,
    query: str = SEARCH_QUERY,
    k: int = 3,
    answer: str = ANSWER_TEXT,
) -> ScenarioRun:
    """Run the full same-turn path once against the deterministic backend."""
    run, service = _build_stack(transport or WeatherTransport())
    recorder = run.recorder
    provider = run.provider
    await service.connect()

    # The user turn is already committed to conversation memory by _build_stack;
    # ingest_user_input() would need a running runtime loop, and the origin_ref
    # argument is the same admission path the bridge unit tests exercise.
    recorder.record("user.turn", {"text": USER_TURN})

    await service.handle_event(ResponseStarted(session_epoch=1, response_id=ORIGIN_RESPONSE_ID))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id=SEARCH_CALL_ID,
            item_id="item-search",
            name="search__search",
            arguments={"query": query, "k": k, "origin_ref": "conversation:1"},
            response_id=ORIGIN_RESPONSE_ID,
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id=ORIGIN_RESPONSE_ID,
            status="completed",
            reason="completed",
        )
    )
    recorder.record(
        "origin.terminal",
        {"response_id": ORIGIN_RESPONSE_ID, "status": "completed"},
    )

    handoffs: list[Any] = []
    run.runtime.observe(handoffs.append)
    # Drains the real SearchAdapter task, posts the real HandoffEvent to observers,
    # and then fires the dispatch-bound +10s Deadline, which must be a no-op.
    await run.runtime.run()
    for event in handoffs:
        if getattr(event, "channel", None) == "search" and hasattr(event, "outcome"):
            content = event.content if isinstance(event.content, Mapping) else {}
            results = content.get("results")
            recorder.record(
                "search.handoff",
                {
                    "delegate_id": event.delegate_id,
                    "outcome": event.outcome,
                    "result_count": len(results) if isinstance(results, list) else 0,
                },
            )

    await service.flush_host_items()
    await service._drive_continuations()

    assert provider.continuation_ids, "the confirmed tool result must create a continuation"
    continuation_id = provider.continuation_ids[0]
    await service.handle_event(ResponseStarted(session_epoch=1, response_id=continuation_id))
    await service.handle_event(
        ResponseTranscriptDelta(session_epoch=1, response_id=continuation_id, text=answer[:6])
    )
    pcm = b"\x00\x01" * 480
    await service.handle_event(
        ResponseAudioDelta(session_epoch=1, response_id=continuation_id, pcm=pcm)
    )
    recorder.record("audio.delta", {"response_id": continuation_id, "bytes": len(pcm)})
    await service.handle_event(
        ResponseTranscriptFinal(session_epoch=1, response_id=continuation_id, text=answer)
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id=continuation_id,
            status="completed",
            reason="completed",
        )
    )
    recorder.record(
        "continuation.terminal",
        {"response_id": continuation_id, "status": "completed"},
    )
    generation = service.session.current_generation
    if generation is not None:
        service.playback_done(generation.utterance_id, generation.generation_epoch)
    return run


def _codes(report: ScenarioReport) -> list[str]:
    return [finding.code for finding in report.findings]


def _message(report: ScenarioReport) -> str:
    return (
        f"first failed gate={report.first_failed_gate} findings="
        f"{[(finding.code, finding.event_ref, finding.detail) for finding in report.findings]}"
    )


async def test_weather_same_turn_deterministic_backend_passes_every_gate() -> None:
    """The whole R105 path end to end: one search call, held continuation, grounded answer."""
    run = await drive_scenario()

    report = evaluate_weather_same_turn(run.records, live=False)

    assert report.passed, _message(report)
    assert [gate.passed for gate in report.gates] == [True] * 5
    assert run.transport.queries == [(SEARCH_QUERY, 3)]
    assert run.provider.connected_tool_names.count("search__search") == 1
    assert [record["kind"] for record in run.records] == [
        "user.turn",
        "tool.call",
        "tool.accepted",
        "origin.terminal",
        "search.handoff",
        "tool.output",
        "continuation.created",
        "audio.delta",
        "answer.transcript",
        "continuation.terminal",
    ]


async def test_continuation_is_held_until_the_search_result_is_confirmed() -> None:
    """Gate 2's hold invariant is a property of the production service, not the recorder."""
    run, service = _build_stack(WeatherTransport())
    await service.connect()
    await service.handle_event(ResponseStarted(session_epoch=1, response_id=ORIGIN_RESPONSE_ID))
    await service.handle_event(
        ToolCallReady(
            session_epoch=1,
            call_id=SEARCH_CALL_ID,
            item_id="item-search",
            name="search__search",
            arguments={"query": SEARCH_QUERY, "k": 3, "origin_ref": "conversation:1"},
            response_id=ORIGIN_RESPONSE_ID,
        )
    )
    await service.handle_event(
        ResponseTerminal(
            session_epoch=1,
            response_id=ORIGIN_RESPONSE_ID,
            status="completed",
            reason="completed",
        )
    )

    assert run.provider.injected == []
    assert run.provider.response_intents == []

    await run.runtime.run()
    await service.flush_host_items()
    await service._drive_continuations()

    assert [item.call_id for item in run.provider.injected] == [SEARCH_CALL_ID]
    assert len(run.provider.response_intents) == 1
    assert run.provider.response_intents[0].kind == "tool_result"


async def test_dispatch_bound_deadline_fires_after_resolution_and_is_a_no_op() -> None:
    """The +10s Deadline still enters the queue; the first-event-wins rule makes it inert."""
    run = await drive_scenario()

    assert run.clock.now() >= 10.0, "the dispatch-bound deadline must have been reached"
    outputs = [record for record in run.records if record["kind"] == "tool.output"]
    assert len(outputs) == 1
    assert json.loads(outputs[0]["data"]["content"])["state"] == "ok"
    assert len(run.provider.response_intents) == 1
    assert evaluate_weather_same_turn(run.records, live=False).passed


async def test_max_size_legal_fixture_keeps_gate_three_green() -> None:
    """P1 boundary: 512-char query, 5 results, 300/2000-char titles and snippets."""
    run = await drive_scenario(
        transport=WeatherTransport(MAX_LEGAL_RESULTS),
        query=MAX_LEGAL_QUERY,
        k=5,
    )

    report = evaluate_weather_same_turn(run.records, live=False)
    gate3 = next(gate for gate in report.gates if gate.name == "gate3_tool_result_integrity")
    assert gate3.passed, _message(report)

    content = next(record for record in run.records if record["kind"] == "tool.output")["data"][
        "content"
    ]
    payload = json.loads(content)
    assert len(content) <= 3000
    assert payload["state"] == "ok"
    assert payload["results"], "shrinking must retain at least one result"
    assert all(len(result["title"]) <= 120 for result in payload["results"])
    assert all(len(result["snippet"]) <= 400 for result in payload["results"])


async def test_report_mapping_is_json_serializable() -> None:
    run = await drive_scenario()
    report = evaluate_weather_same_turn(run.records, live=False)

    mapping = build_report_mapping(
        report,
        records=run.records,
        manifest={"scenario_id": SCENARIO_ID, "backend": "deterministic", "attempt": 1},
    )

    encoded = json.dumps(mapping, ensure_ascii=False, sort_keys=True)
    assert json.loads(encoded)["passed"] is True
    assert json.loads(encoded)["first_failed_gate"] is None
    assert mapping["metrics"]["source_attribution"] is False


# --------------------------------------------------------------------------------------
# Mutation sensitivity: a pure valid record list, mutated one way at a time.
# --------------------------------------------------------------------------------------

VALID_TOOL_OUTPUT = json.dumps(
    {
        "state": "ok",
        "query": SEARCH_QUERY,
        "results": [
            {
                "title": "北京当前天气",
                "snippet": "北京当前晴，气温二十五摄氏度。",
                "source": "weather.example.test",
            }
        ],
    },
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
)


def build_valid_records() -> list[dict[str, Any]]:
    entries: list[tuple[str, dict[str, Any]]] = [
        ("user.turn", {"text": USER_TURN}),
        (
            "tool.call",
            {"call_id": SEARCH_CALL_ID, "name": "search__search", "query": SEARCH_QUERY, "k": 3},
        ),
        (
            "tool.accepted",
            {
                "call_id": SEARCH_CALL_ID,
                "delegate_id": "d-1",
                "sync_result": True,
                "state": "pending",
                "code": "accepted",
            },
        ),
        ("origin.terminal", {"response_id": ORIGIN_RESPONSE_ID, "status": "completed"}),
        ("search.handoff", {"delegate_id": "d-1", "outcome": "ok", "result_count": 1}),
        ("tool.output", {"call_id": SEARCH_CALL_ID, "content": VALID_TOOL_OUTPUT}),
        ("continuation.created", {"response_id": "continuation-1"}),
        ("audio.delta", {"response_id": "continuation-1", "bytes": 960}),
        ("answer.transcript", {"text": ANSWER_TEXT}),
        ("continuation.terminal", {"response_id": "continuation-1", "status": "completed"}),
    ]
    return [
        {
            "event_ref": f"e{index:03d}",
            "t_ms": float(index),
            "kind": kind,
            "data": dict(data),
        }
        for index, (kind, data) in enumerate(entries, start=1)
    ]


def _index_of(records: list[dict[str, Any]], kind: str) -> int:
    return next(index for index, record in enumerate(records) if record["kind"] == kind)


def _mutate_premature_continuation(records: list[dict[str, Any]]) -> None:
    continuation = records.pop(_index_of(records, "continuation.created"))
    records.insert(_index_of(records, "origin.terminal"), continuation)


def _mutate_duplicate_continuation(records: list[dict[str, Any]]) -> None:
    index = _index_of(records, "continuation.created")
    records.insert(index + 1, json.loads(json.dumps(records[index])))


def _mutate_truncated_json(records: list[dict[str, Any]]) -> None:
    record = records[_index_of(records, "tool.output")]
    record["data"]["content"] = record["data"]["content"][:-12]


def _mutate_internal_ref_leak(records: list[dict[str, Any]]) -> None:
    record = records[_index_of(records, "tool.output")]
    payload = json.loads(record["data"]["content"])
    payload["results"][0]["evidence_ref"] = "web.search://evidence/1111"
    record["data"]["content"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _mutate_no_search_call(records: list[dict[str, Any]]) -> None:
    records.pop(_index_of(records, "tool.call"))


def _mutate_codex_called(records: list[dict[str, Any]]) -> None:
    index = _index_of(records, "tool.call")
    records.insert(
        index,
        {
            "event_ref": "e900",
            "t_ms": 1.5,
            "kind": "tool.call",
            "data": {"call_id": "call-codex", "name": "codex__run", "query": "北京天气", "k": 1},
        },
    )


def _mutate_k_out_of_range(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "tool.call")]["data"]["k"] = 9


def _mutate_answer_denies_realtime(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "answer.transcript")]["data"]["text"] = (
        "抱歉，我无法获取北京的实时天气信息。"
    )


def _mutate_answer_ungrounded(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "answer.transcript")]["data"]["text"] = (
        "北京的情况我已经帮你看过了，整体还不错。"
    )


def _mutate_answer_recites_protocol(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "answer.transcript")]["data"]["text"] = (
        '北京当前晴，气温二十五度，来自 https://weather.example.test/beijing 的 "results"。'
    )


def _mutate_missing_transcript(records: list[dict[str, Any]]) -> None:
    records.pop(_index_of(records, "answer.transcript"))


def _mutate_handoff_delegate_mismatch(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "search.handoff")]["data"]["delegate_id"] = "d-other"


def _mutate_sync_result_not_declared(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "tool.accepted")]["data"]["sync_result"] = False


def _mutate_duplicate_tool_output(records: list[dict[str, Any]]) -> None:
    index = _index_of(records, "tool.output")
    records.insert(index + 1, json.loads(json.dumps(records[index])))


def _mutate_tool_output_too_long(records: list[dict[str, Any]]) -> None:
    record = records[_index_of(records, "tool.output")]
    payload = json.loads(record["data"]["content"])
    payload["results"][0]["snippet"] = "摘" * 3200
    record["data"]["content"] = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _mutate_search_query_loses_location(records: list[dict[str, Any]]) -> None:
    records[_index_of(records, "tool.call")]["data"]["query"] = "实时天气 气温"


def _mutate_missing_continuation_terminal(records: list[dict[str, Any]]) -> None:
    records.pop(_index_of(records, "continuation.terminal"))


MUTATIONS = [
    ("premature_continuation", _mutate_premature_continuation, "premature_continuation"),
    ("duplicate_continuation", _mutate_duplicate_continuation, "duplicate_continuation"),
    ("truncated_json", _mutate_truncated_json, "tool_output_not_json"),
    ("internal_ref_leak", _mutate_internal_ref_leak, "tool_output_internal_ref_leak"),
    ("no_search_call", _mutate_no_search_call, "search_call_missing"),
    ("codex_called", _mutate_codex_called, "codex_tool_called"),
    ("k_out_of_range", _mutate_k_out_of_range, "search_k_out_of_range"),
    (
        "answer_denies_realtime",
        _mutate_answer_denies_realtime,
        "answer_claims_realtime_unavailable",
    ),
    ("answer_ungrounded", _mutate_answer_ungrounded, "answer_not_grounded_in_evidence"),
    ("answer_recites_protocol", _mutate_answer_recites_protocol, "answer_recites_protocol"),
    ("missing_transcript", _mutate_missing_transcript, "answer_transcript_missing"),
    (
        "handoff_delegate_mismatch",
        _mutate_handoff_delegate_mismatch,
        "handoff_delegate_mismatch",
    ),
    ("sync_result_not_declared", _mutate_sync_result_not_declared, "sync_result_not_declared"),
    ("duplicate_tool_output", _mutate_duplicate_tool_output, "duplicate_tool_output"),
    ("tool_output_too_long", _mutate_tool_output_too_long, "tool_output_too_long"),
    (
        "search_query_loses_location",
        _mutate_search_query_loses_location,
        "search_query_missing_location",
    ),
    (
        "missing_continuation_terminal",
        _mutate_missing_continuation_terminal,
        "continuation_terminal_missing",
    ),
]


def test_the_unmutated_record_fixture_passes() -> None:
    report = evaluate_weather_same_turn(build_valid_records(), live=False)
    assert report.passed, _message(report)


async def test_the_record_fixture_matches_the_real_backend_shape() -> None:
    """The pure mutation fixture must not drift from what the production stack emits."""
    run = await drive_scenario()
    live_kinds = [record["kind"] for record in run.records]
    fixture_kinds = [record["kind"] for record in build_valid_records()]
    assert sorted(live_kinds) == sorted(fixture_kinds)


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [(mutation, code) for _name, mutation, code in MUTATIONS],
    ids=[name for name, _mutation, _code in MUTATIONS],
)
def test_mutation_is_detected(mutation: Any, expected_code: str) -> None:
    records = build_valid_records()
    mutation(records)

    report = evaluate_weather_same_turn(records, live=False)

    assert not report.passed, f"mutation {expected_code} was not detected"
    assert expected_code in _codes(report), _message(report)
    assert report.first_failed_gate is not None


def test_gate_six_only_applies_to_the_live_backend() -> None:
    records = build_valid_records()
    records.pop(_index_of(records, "audio.delta"))

    assert evaluate_weather_same_turn(records, live=False).passed
    live_report = evaluate_weather_same_turn(records, live=True)
    assert "live_audio_missing" in _codes(live_report)
    assert live_report.first_failed_gate == "gate6_live_output_health"


def test_live_backend_accepts_the_complete_record_stream() -> None:
    assert evaluate_weather_same_turn(build_valid_records(), live=True).passed


def test_recorder_drops_fields_outside_the_allowlist() -> None:
    recorder = ScenarioRecorder(clock=VirtualClock())

    record = recorder.record(
        "tool.call",
        {
            "call_id": "c1",
            "name": "search__search",
            "query": "北京天气",
            "k": 3,
            "api_key": "secret",
        },
    )

    assert "api_key" not in record["data"]
    assert record["event_ref"] == "e001"
    with pytest.raises(ValueError):
        recorder.record("provider.raw_frame", {"text": "nope"})


def test_live_recording_normalizes_multiline_delivery_transcript() -> None:
    """A normal Qwen transcript may contain newlines; the artifact stays one printable line."""
    recorder = ScenarioRecorder(clock=VirtualClock())
    recording = LiveRecording(recorder)
    recording.continuation_response_ids.add("continuation-1")

    recording.on_delivery(
        PlaybackCompletion(
            session_epoch=1,
            response_id="continuation-1",
            utterance_id="utterance-1",
            generation_epoch=1,
            text="北京现在多云。\n气温二十五摄氏度。",
            disposition="spoken",
            started=True,
            played_ms=1_000,
        )
    )

    assert recorder.records[-1]["data"]["text"] == "北京现在多云。 气温二十五摄氏度。"


def test_findings_are_stable_snake_case_codes() -> None:
    records = build_valid_records()
    _mutate_truncated_json(records)
    report = evaluate_weather_same_turn(records, live=False)

    assert all(isinstance(finding, Finding) for finding in report.findings)
    assert all(finding.code == finding.code.lower() for finding in report.findings)
    assert all(" " not in finding.code for finding in report.findings)


def test_answer_without_beijing_is_grounded_when_no_other_city_appears() -> None:
    """The fixed turn names Beijing, so omitting it stays unambiguous (design doc)."""
    records = build_valid_records()
    records[_index_of(records, "answer.transcript")]["data"]["text"] = (
        "现在是晴天，气温二十五摄氏度。"
    )

    report = evaluate_weather_same_turn(records, live=False)

    assert report.passed, _message(report)
    assert report.metrics["answer_names_location"] is False


def test_answer_naming_a_different_city_fails_grounding() -> None:
    records = build_valid_records()
    records[_index_of(records, "answer.transcript")]["data"]["text"] = (
        "上海现在晴，气温二十五摄氏度。"
    )

    report = evaluate_weather_same_turn(records, live=False)

    assert "answer_location_mismatch" in _codes(report)
