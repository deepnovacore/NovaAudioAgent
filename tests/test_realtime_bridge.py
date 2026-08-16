from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Iterator, Mapping
from itertools import count
from typing import Any

import pytest

from nova_audio_agent.clock import RealClock, VirtualClock
from nova_audio_agent.executors.codex import CodexProcessStatus, CodexTransportResult
from nova_audio_agent.executors.codex_app_server import SteerTransportResult
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST, CodexLiveAdapter
from nova_audio_agent.executors.search import SEARCH_MANIFEST, SearchAdapter
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, HandoffPolicy, Memory
from nova_audio_agent.ports import ExecutorManifest, Handoff, OpSpec
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
from nova_audio_agent.realtime.protocol import ToolCallReady
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema


def ids(*values: str) -> Iterator[str]:
    return iter(values)


class PendingCodexWorker:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def preflight(self, *, deadline=None) -> Mapping[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "mount": "workspace_only",
            "subprocess": "contained",
            "network": "blocked",
            "credential": {"present": True, "identity": "chatgpt", "policy": "saved_login"},
            "limits": {"cpu": "finite", "as": "finite", "nofile": "finite"},
        }

    async def run(
        self,
        work_order: str,
        *,
        on_status: Callable[[CodexProcessStatus], None],
        on_progress=None,
        deadline=None,
    ) -> CodexTransportResult:
        del work_order, deadline
        on_status(CodexProcessStatus(running=True, exited=False))
        self.started.set()
        await self.release.wait()
        on_status(CodexProcessStatus(running=False, exited=True, terminal="completed", exit_code=0))
        text = "done"
        return CodexTransportResult(
            classification="completed",
            code="completed",
            content={
                "events": [
                    {"type": "thread.started"},
                    {"type": "turn.started"},
                    {"type": "turn.completed"},
                ],
                "protocol": {
                    "thread_started": True,
                    "turn_started": True,
                    "terminal": "completed",
                    "transport_closed": True,
                    "unknown_event_count": 0,
                },
                "process": {"started": True, "exit_code": 0, "stop": "none"},
                "result": {
                    "final_message": {
                        "text": text,
                        "original_chars": len(text),
                        "truncated": False,
                        "sha256": hashlib.sha256(text.encode()).hexdigest(),
                    }
                },
            },
        )

    async def steer(self, instruction: str) -> SteerTransportResult:
        del instruction
        return SteerTransportResult(code="accepted", written=True)


class StubSearchTransport:
    async def search(self, query: str, *, max_results: int) -> Mapping[str, Any]:
        del query, max_results
        return {
            "request_id": "req-1",
            "results": [
                {
                    "title": "北京天气",
                    "content": "晴，25 度",
                    "url": "https://www.weather.com.cn/beijing",
                }
            ],
        }


WATCH_START = OpSpec(
    name="start",
    description="在后台等待监控条件",
    params={
        "type": "object",
        "properties": {"condition": {"type": "string"}},
        "required": ["condition"],
        "additionalProperties": False,
    },
    readonly=True,
)
WATCH_STOP = OpSpec(
    name="stop",
    description="停止当前监控窗口",
    params={
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    },
    readonly=True,
)
WATCH_STATUS = OpSpec(
    name="status",
    description="读取当前监控状态",
    params={
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    },
    readonly=True,
    sync_result=True,
)


class WatchAdapter:
    manifest = ExecutorManifest(
        name="watch",
        ops=(WATCH_START, WATCH_STOP, WATCH_STATUS),
        policy=HandoffPolicy(
            channel="watch",
            priority=40,
            wake="surrogate",
            typical_latency=1.0,
            compress_watermark=20,
            suggest=True,
        ),
    )

    async def dispatch(self, op: str, request: dict[str, object], ctx: object) -> Handoff:
        del op, request, ctx
        return Handoff(outcome="ok", trust="trusted_system", content={})


def make_search_bridge() -> tuple[RealtimeRuntimeBridge, Runtime]:
    """The production pairing (D19): codex owns side effects, search is the readonly always-on."""
    clock = VirtualClock()
    adapter = SearchAdapter(StubSearchTransport())
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy, SEARCH_MANIFEST.policy))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "今天天气怎么样"},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={"codex": CodexLiveAdapter(PendingCodexWorker()), "search": adapter},
    )
    tools = compile_tool_schema((CODEX_LIVE_MANIFEST, SEARCH_MANIFEST))
    id_values = ids("host-tool-1", "event-tool-1")
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=lambda: next(id_values),
    )
    return bridge, runtime


def make_bridge() -> tuple[RealtimeRuntimeBridge, Runtime, PendingCodexWorker]:
    clock = VirtualClock()
    worker = PendingCodexWorker()
    adapter = CodexLiveAdapter(worker)
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "实现俄罗斯方块"},
    )
    runtime = Runtime(clock=clock, memory=memory, executors={"codex": adapter})
    tools = compile_tool_schema((CODEX_LIVE_MANIFEST,))
    id_values = ids("host-tool-1", "event-tool-1")
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=lambda: next(id_values),
    )
    return bridge, runtime, worker


def make_watch_bridge() -> tuple[RealtimeRuntimeBridge, Runtime]:
    clock = VirtualClock()
    adapter = WatchAdapter()
    codex = CodexLiveAdapter(PendingCodexWorker())
    memory = Memory(policies=(codex.manifest.policy, adapter.manifest.policy))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "看到水杯时告诉我"},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={"codex": codex, "watch": adapter},  # type: ignore[arg-type]
    )
    tools = compile_tool_schema((adapter.manifest,))
    bridge = RealtimeRuntimeBridge(runtime=runtime, tools=tools, id_factory=lambda: "host-watch")
    return bridge, runtime


def make_memory_recall_bridge() -> tuple[RealtimeRuntimeBridge, Runtime]:
    memory = Memory(policies=(WatchAdapter.manifest.policy,))
    memory.append(
        "watch",
        ts=1.0,
        trust="trusted_system",
        priority=40,
        outcome="ok",
        content={
            "hit": True,
            "condition": "出现水杯",
            "observation": "桌面上出现蓝色水杯",
            "media_ref": "private-media",
        },
    )
    runtime = Runtime(clock=VirtualClock(), memory=memory)
    tools = compile_tool_schema((), include_memory_recall=True)
    ids = count(1)
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=lambda: f"recall-{next(ids)}",
    )
    return bridge, runtime


@pytest.mark.asyncio
async def test_foreign_tool_is_refused_without_dispatch() -> None:
    """Trusting a provider tool name outside CompiledTools would expand runtime authority."""
    bridge, runtime, _worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__shell",
            arguments={},
        )
    )

    assert result.accepted is False
    assert result.code == "unknown_tool"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_memory_recall_fulfills_inline_without_runtime_dispatch() -> None:
    bridge, runtime = make_memory_recall_bridge()
    question = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才看到了什么"},
    )
    before = {channel: tuple(board.items) for channel, board in runtime.memory.channels.items()}

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "recent"},
            response_id="response-1",
        ),
        origin_ref=question.ref,
    )

    payload = json.loads(result.host_item.content)
    assert result.accepted is True
    assert result.inline_fulfilled is True
    assert result.sync_result is False
    assert result.delegate_id is None
    assert result.executor is None
    assert result.op is None
    assert runtime.delegates.snapshot() == ()
    assert {
        channel: tuple(board.items) for channel, board in runtime.memory.channels.items()
    } == before
    assert payload["hits"][0]["ref"] == "watch:1"
    assert all(hit["ref"] != question.ref for hit in payload["hits"])
    assert "private-media" not in result.host_item.content


@pytest.mark.asyncio
async def test_memory_recall_requires_an_accepted_user_origin() -> None:
    bridge, runtime = make_memory_recall_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "recent"},
        )
    )

    assert result.accepted is False
    assert result.code == "missing_origin_ref"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_memory_recall_rejects_scope_outside_the_schema_enum() -> None:
    bridge, runtime = make_memory_recall_bridge()
    question = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才看到了什么"},
    )

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "all_time"},
        ),
        origin_ref=question.ref,
    )

    assert result.accepted is False
    assert result.code == "invalid_params"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_memory_recall_rejects_whitespace_query_as_invalid_params() -> None:
    bridge, runtime = make_memory_recall_bridge()
    question = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才看到了什么"},
    )

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "   ", "scope": "recent"},
        ),
        origin_ref=question.ref,
    )

    assert result.accepted is False
    assert result.code == "invalid_params"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_memory_recall_telemetry_is_detached_and_contains_no_plaintext() -> None:
    bridge, runtime = make_memory_recall_bridge()
    query = "刚才看到了什么"
    question = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": query},
    )

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": query, "scope": "recent"},
        ),
        origin_ref=question.ref,
    )

    assert result.telemetry is not None
    telemetry = dict(result.telemetry)
    assert telemetry["raw_scanned"] == 1
    query_digest = telemetry["query_digest"]
    assert isinstance(query_digest, str)
    assert len(query_digest) == 64
    assert query_digest != hashlib.sha256(query.encode()).hexdigest()
    assert telemetry["hit_refs"] == ("watch:1",)
    assert telemetry["matches"] == {"lexical": 0, "recency_fallback": 1}
    serialized = json.dumps(telemetry, ensure_ascii=False)
    assert query not in serialized
    assert "桌面上出现蓝色水杯" not in serialized

    other_bridge, other_runtime = make_memory_recall_bridge()
    other_question = other_runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": query},
    )
    other_result = await other_bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": query, "scope": "recent"},
        ),
        origin_ref=other_question.ref,
    )
    assert other_result.telemetry is not None
    assert other_result.telemetry["query_digest"] != query_digest


@pytest.mark.asyncio
async def test_memory_recall_telemetry_describes_only_hits_that_fit_output() -> None:
    memory = Memory(policies=(WatchAdapter.manifest.policy,))
    for index in range(5):
        memory.append(
            "watch",
            ts=float(index),
            trust="trusted_system",
            priority=40,
            outcome="ok",
            content={
                "hit": True,
                "condition": f"condition-{index}",
                "observation": f"observation-{index}-" + "x" * 580,
            },
        )
    question = memory.append(
        CONVERSATION_CHANNEL,
        ts=6.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "unrelated query"},
    )
    runtime = Runtime(clock=VirtualClock(), memory=memory)
    tools = compile_tool_schema((), include_memory_recall=True)
    serial = count(1)
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=lambda: f"recall-{next(serial)}",
    )

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "unrelated query", "scope": "recent"},
        ),
        origin_ref=question.ref,
    )

    payload = json.loads(result.host_item.content)
    assert 0 < len(payload["hits"]) < 5
    assert result.telemetry is not None
    telemetry = dict(result.telemetry)
    assert telemetry["hit_count"] == len(payload["hits"])
    assert telemetry["hit_refs"] == tuple(hit["ref"] for hit in payload["hits"])
    assert telemetry["omitted"] == payload["omitted"]
    assert sum(telemetry["matches"].values()) == len(payload["hits"])


@pytest.mark.asyncio
async def test_memory_recall_exception_returns_bounded_error_result(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bridge, runtime = make_memory_recall_bridge()
    question = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=2.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "刚才看到了什么"},
    )

    def fail(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("private failure detail")

    monkeypatch.setattr("nova_audio_agent.realtime.bridge.compile_memory_recall", fail)
    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recall",
            item_id="item-recall",
            name="memory__recall",
            arguments={"query": "刚才看到了什么", "scope": "recent"},
        ),
        origin_ref=question.ref,
    )

    assert result.accepted is True
    assert result.inline_fulfilled is True
    assert result.code == "error"
    assert json.loads(result.host_item.content) == {
        "state": "error",
        "scope": "recent",
        "raw_scanned": 0,
        "searched_count": 0,
        "scan_truncated": False,
        "hits": [],
        "omitted": 0,
    }
    assert "private failure detail" not in result.host_item.content
    assert len(result.host_item.content) < 3000
    assert runtime.delegates.snapshot() == ()
    diagnostic = capsys.readouterr().out
    assert diagnostic == "[realtime-diagnostic] memory_recall_projection_error type=RuntimeError\n"
    assert "private failure detail" not in diagnostic
    assert "刚才看到了什么" not in diagnostic


@pytest.mark.asyncio
async def test_missing_origin_ref_is_refused_without_dispatch() -> None:
    """A tool proposal without causal attribution must not enter the delegate ledger."""
    bridge, runtime, _worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现它"},
        )
    )

    assert result.accepted is False
    assert result.code == "missing_origin_ref"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_host_selected_origin_ref_wins_when_transcripts_finish_out_of_order() -> None:
    """A service-correlated user item must not be replaced by the bridge's newer
    latest transcript or by a provider-supplied fallback reference."""
    bridge, runtime = make_watch_bridge()
    first_origin = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=runtime.clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "第一个任务"},
    ).ref
    latest_origin = runtime.memory.append(
        CONVERSATION_CHANNEL,
        ts=runtime.clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "第二个任务"},
    ).ref
    bridge._latest_user_origin_ref = latest_origin

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="watch__start",
            arguments={"condition": "执行第一个任务", "origin_ref": "conversation:1"},
        ),
        origin_ref=first_origin,
    )

    assert result.accepted is True
    assert runtime.delegates.snapshot()[0].origin_ref == first_origin == "conversation:2"
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_whitespace_work_order_is_refused_before_runtime_dispatch() -> None:
    """Validating the acknowledgement after dispatch can orphan accepted slow work."""
    bridge, runtime, _worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={
                "work_order": "   ",
                "origin_ref": "conversation:1",
            },
        )
    )

    assert result.accepted is False
    assert result.code == "invalid_params"
    assert runtime.delegates.snapshot() == ()


@pytest.mark.asyncio
async def test_codex_tool_acceptance_is_immediate_while_app_server_run_stays_live() -> None:
    """Awaiting Codex completion here would recreate a blocking ReAct tool call."""
    bridge, runtime, worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={
                "work_order": "实现它",
                "origin_ref": "conversation:1",
            },
            response_id="response-1",
        )
    )

    assert result.accepted is True
    assert result.code == "accepted"
    assert result.sync_result is False
    assert result.delegate_id == "d-1"
    assert result.host_item.call_id == "call-1"
    assert result.host_item.content == '{"state":"accepted"}'
    assert result.response_intent.kind == "delegation_acknowledgement"
    assert result.response_intent.item is result.host_item
    assert result.response_intent.task_summary == "实现它"
    assert "d-1" not in result.host_item.content
    assert runtime.delegates.snapshot()[0].delegate_id == "d-1"
    assert worker.started.is_set() is False

    await asyncio.sleep(0)
    assert worker.started.is_set() is True
    worker.release.set()
    await runtime.run()


@pytest.mark.asyncio
async def test_delegate_ack_uses_condition_and_carries_executor() -> None:
    """Generic delegates must preserve their manifest identity and acknowledgement subject."""
    bridge, _runtime = make_watch_bridge()

    acceptance = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-watch",
            item_id="item-watch",
            name="watch__start",
            arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
        )
    )

    assert acceptance.executor == "watch"
    assert acceptance.op == "start"
    assert acceptance.response_intent.task_summary == "出现水杯"


@pytest.mark.asyncio
async def test_watch_start_routes_ambient_while_other_ops_stay_user_awaited() -> None:
    """#51/R128: a suggest-channel start window is an ambient observation the
    Surrogate arbitrates; stop and the R105 sync status stay user-awaited."""
    bridge, runtime = make_watch_bridge()

    start = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-start",
            item_id="item-start",
            name="watch__start",
            arguments={"condition": "出现水杯", "origin_ref": "conversation:1"},
        )
    )
    stop = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-stop",
            item_id="item-stop",
            name="watch__stop",
            arguments={"origin_ref": "conversation:1"},
        )
    )
    status = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-status",
            item_id="item-status",
            name="watch__status",
            arguments={"origin_ref": "conversation:1"},
        )
    )

    assert start.accepted is True
    assert stop.accepted is True
    assert status.accepted is True
    assert status.sync_result is True
    routing = {
        delegate.op: delegate.routing_class
        for delegate in runtime.delegates.snapshot()
        if delegate.executor == "watch"
    }
    assert routing == {
        "start": "ambient",
        "stop": "user_awaited",
        "status": "user_awaited",
    }


@pytest.mark.asyncio
async def test_codex_dispatch_stays_user_awaited() -> None:
    """#51/R128: only suggest-channel start windows route ambient."""
    bridge, runtime, _worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="codex__run",
            arguments={"work_order": "实现俄罗斯方块", "origin_ref": "conversation:1"},
        )
    )

    assert result.accepted is True
    (delegate,) = runtime.delegates.snapshot()
    assert delegate.routing_class == "user_awaited"


@pytest.mark.asyncio
async def test_sync_result_op_returns_pending_tool_result_and_still_dispatches() -> None:
    """R105: a fast readonly op holds the provider protocol open instead of announcing a task."""
    bridge, runtime = make_search_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-1",
            item_id="item-1",
            name="search__search",
            arguments={"query": "北京天气", "k": 3, "origin_ref": "conversation:1"},
            response_id="response-1",
        )
    )

    assert result.accepted is True
    assert result.code == "accepted"
    assert result.sync_result is True
    assert result.op == "search"
    assert result.delegate_id == "d-1"
    assert result.host_item.call_id == "call-1"
    assert result.host_item.content == '{"state":"pending"}'
    assert result.response_intent.kind == "tool_result"
    assert result.response_intent.item is result.host_item
    assert result.response_intent.task_summary is None
    assert runtime.delegates.snapshot()[0].delegate_id == "d-1"
    await runtime.run()


@pytest.mark.asyncio
async def test_realtime_transcript_is_applied_before_host_binds_tool_origin() -> None:
    """A provider cannot race dispatch or guess the MemoryRef assigned by the host."""
    clock = RealClock()
    worker = PendingCodexWorker()
    adapter = CodexLiveAdapter(worker)
    memory = Memory(policies=(CODEX_LIVE_MANIFEST.policy,))
    runtime = Runtime(clock=clock, memory=memory, executors={"codex": adapter})
    tools = compile_tool_schema((CODEX_LIVE_MANIFEST,))
    id_values = ids("host-tool-1", "event-tool-1")
    bridge = RealtimeRuntimeBridge(
        runtime=runtime,
        tools=tools,
        id_factory=lambda: next(id_values),
    )
    stop = asyncio.Event()
    runner = asyncio.create_task(runtime.serve(stop))

    try:
        await bridge.accept_user_transcript("帮我生成一个横版游戏")
        result = await bridge.accept_tool_call(
            ToolCallReady(
                session_epoch=1,
                call_id="call-1",
                item_id="item-1",
                name="codex__run",
                arguments={
                    "work_order": "生成横版游戏",
                    "origin_ref": "conversation:999",
                },
            )
        )

        assert result.accepted is True
        assert runtime.delegates.snapshot()[0].origin_ref == "conversation:1"
        await worker.started.wait()
    finally:
        worker.release.set()
        stop.set()
        await runner


@pytest.mark.asyncio
async def test_compiled_update_tool_uses_runtime_structured_state_writer() -> None:
    """Refusing compiled update tools would make realtime use a smaller shadow manifest."""
    bridge, runtime, _worker = make_bridge()

    result = await bridge.accept_tool_call(
        ToolCallReady(
            session_epoch=1,
            call_id="call-update",
            item_id="item-update",
            name="update_goal",
            arguments={
                "objective": "Ship the Qwen desktop",
                "acceptance_criteria": ["Codex remains steerable"],
                "status": "accepted",
            },
        )
    )

    assert result.accepted is True
    assert result.code == "completed"
    assert result.host_item.content == '{"state":"completed"}'
    assert runtime.memory.structured.goal.objective == "Ship the Qwen desktop"
    assert runtime.memory.structured.goal.acceptance_criteria == ("Codex remains steerable",)
