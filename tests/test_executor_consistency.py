from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import pytest

from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.autoglm import AutoGlmAdapter, WdaScreenshot
from nova_audio_agent.executors.autoglm_protocol import AutoGlmWorkerResult
from nova_audio_agent.executors.camera import CamAdapter, Frame, ScriptedFrameSource
from nova_audio_agent.executors.codex import (
    CodexAdapter,
    CodexProcessStatus,
    CodexRunDeadline,
    CodexTransportResult,
)
from nova_audio_agent.executors.search import (
    SearchAdapter,
    TavilyTransportFailure,
)
from nova_audio_agent.executors.home_assistant import HomeAssistantAdapter
from nova_audio_agent.executors.sims import FastSim, SlowSim
from nova_audio_agent.memory import Memory
from nova_audio_agent.media import MediaStore
from nova_audio_agent.ports import (
    DelegateRequest,
    DispatchContext,
    Handoff,
    OpSpec,
    bind_delegate,
)


class _ImmediateClock:
    def __init__(self, start: float = 7.0) -> None:
        self._now = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self._now

    async def sleep(self, duration: float) -> None:
        self.sleeps.append(duration)
        self._now += duration


class _SuccessTransport:
    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        return {
            "request_id": "req-consistency",
            "results": [
                {
                    "title": "Nova Audio Agent",
                    "url": "https://docs.example.com/nova",
                    "content": f"Evidence for {query}, bounded to {max_results} results.",
                }
            ],
        }


class _FailureTransport:
    def __init__(self, code: str) -> None:
        self.code = code

    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        raise TavilyTransportFailure(self.code)


class _HomeAssistantTransport:
    async def get_state(self, entity_id: str) -> dict[str, Any]:
        return {
            "entity_id": entity_id,
            "state": "on",
            "attributes": {
                "brightness": 128,
                "color_temp_kelvin": 3000,
                "min_color_temp_kelvin": 1700,
                "max_color_temp_kelvin": 6500,
                "supported_color_modes": ["color_temp"],
            },
            "last_changed": "2026-07-30T09:00:00+00:00",
            "last_updated": "2026-07-30T09:00:01+00:00",
        }

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        del service, service_data
        return []


class _CodexWorker:
    async def preflight(
        self,
        *,
        deadline: CodexRunDeadline | None = None,
    ) -> dict[str, Any]:
        return {
            "version": "0.145.0",
            "root_matches": True,
            "credential": {"present": True, "identity": "chatgpt"},
        }

    async def run(
        self,
        work_order: str,
        *,
        on_status,
        deadline: CodexRunDeadline | None = None,
    ) -> CodexTransportResult:
        del work_order
        on_status(CodexProcessStatus(running=True, exited=False))
        on_status(
            CodexProcessStatus(
                running=False,
                exited=True,
                terminal="completed",
                exit_code=0,
            )
        )
        return CodexTransportResult(
            classification="completed",
            code="completed",
            content={
                "events": [
                    {"type": "thread.started"},
                    {"type": "turn.started"},
                    {"type": "internal_activity", "count": 1},
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
                        "text": "done",
                        "original_chars": 4,
                        "truncated": False,
                        "sha256": (
                            "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211"
                        ),
                    }
                },
            },
        )


class _AutoGlmWorker:
    async def run_browse(self, query: str, *, deadline: object) -> AutoGlmWorkerResult:
        del query, deadline
        return AutoGlmWorkerResult(
            outcome="completed",
            code="completed",
            effect_verification="not_performed",
            events=(),
        )


class _AutoGlmWda:
    async def active_bundle_id(self) -> str:
        return "com.apple.mobilesafari"

    async def screenshot(self) -> WdaScreenshot:
        return WdaScreenshot(
            payload=b"png",
            media_type="image/png",
            width=2,
            height=3,
        )


@dataclass(frozen=True)
class _AdapterCase:
    name: str
    factory: Callable[[], Any]


CASES = (
    _AdapterCase("fast_sim", lambda: FastSim(latency=0.05)),
    _AdapterCase("slow_sim", lambda: SlowSim(latency=5.0)),
    _AdapterCase("search", lambda: SearchAdapter(_SuccessTransport())),
    _AdapterCase(
        "cam",
        lambda: CamAdapter(
            ScriptedFrameSource(
                Frame(
                    payload=b"jpeg",
                    media_type="image/jpeg",
                    width=1280,
                    height=720,
                    captured_at=7.0,
                )
            ),
            MediaStore(),
        ),
    ),
    _AdapterCase(
        "ha",
        lambda: HomeAssistantAdapter(
            _HomeAssistantTransport(),
            entity_id="light.bedside_lamp",
        ),
    ),
    _AdapterCase("codex", lambda: CodexAdapter(_CodexWorker())),
    _AdapterCase(
        "autoglm",
        lambda: AutoGlmAdapter(_AutoGlmWorker(), _AutoGlmWda(), MediaStore()),
    ),
)


@pytest.fixture(params=CASES, ids=lambda case: case.name)
def adapter(request: pytest.FixtureRequest):
    return request.param.factory()


def _valid_request(adapter: Any, op: OpSpec) -> dict[str, Any]:
    if adapter.manifest.name == "cam":
        return {}
    if op.name == "search":
        return {"query": "Nova Audio Agent", "k": 1}
    if adapter.manifest.name == "ha":
        if op.name == "get_state":
            return {}
        if op.name == "set_light":
            return {"brightness_pct": 30}
    if adapter.manifest.name == "codex":
        if op.name == "run":
            return {"work_order": "write the bounded test fixture"}
        if op.name == "status":
            return {}
    if adapter.manifest.name == "autoglm":
        return {"query": "Nova Audio Agent"} if op.name == "browse" else {}
    if op.name == "set_light":
        return {"room": "客厅", "brightness": 30}
    if op.name == "get_state":
        return {"room": "客厅"}
    raise AssertionError(f"missing consistency fixture for {op.name}")


def _ctx(adapter: Any, op: OpSpec, *, clock: _ImmediateClock | None = None) -> DispatchContext:
    clock = clock or _ImmediateClock()
    delegate = bind_delegate(
        DelegateRequest(
            executor=adapter.manifest.name,
            op=op.name,
            request=_valid_request(adapter, op),
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=op,
        now=clock.now(),
        delegate_id=f"d-consistency-{op.name}",
    )
    return DispatchContext(clock=clock, delegate=delegate)


def _assert_executor_boundary(handoff: Handoff, memory: Memory) -> None:
    assert isinstance(handoff, Handoff)
    assert not hasattr(handoff, "assistant_text")
    assert "assistant_text" not in handoff.content
    assert "structured" not in handoff.content
    assert memory.structured == memory.structured.__class__()


def test_every_adapter_has_a_valid_readonly_recheck_entry(adapter: Any) -> None:
    manifest = adapter.manifest
    op_names = {op.name for op in manifest.ops}

    assert any(op.readonly for op in manifest.ops)
    assert all(op.readonly and set(op.verifies) <= op_names for op in manifest.ops if op.verifies)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.name)
def test_runtime_binds_every_deadline_from_the_declared_budget(case: _AdapterCase) -> None:
    adapter = case.factory()

    for op in adapter.manifest.ops:
        clock = _ImmediateClock()
        ctx = _ctx(adapter, op, clock=clock)

        assert ctx.delegate.deadline == clock.now() + op.deadline_budget


async def test_success_stays_a_typed_handoff_without_speech_or_state_writes(adapter: Any) -> None:
    memory = Memory()

    for op in adapter.manifest.ops:
        ctx = _ctx(adapter, op)
        handoff = await adapter.dispatch(op.name, _valid_request(adapter, op), ctx)

        assert handoff.outcome == "ok"
        _assert_executor_boundary(handoff, memory)


async def test_every_adapter_turns_unknown_ops_into_typed_failures(adapter: Any) -> None:
    memory = Memory()
    op = adapter.manifest.ops[0]

    handoff = await adapter.dispatch("does_not_exist", {}, _ctx(adapter, op))

    assert handoff.outcome == "failed"
    assert handoff.content["error"] == "unknown_op"
    _assert_executor_boundary(handoff, memory)


async def test_every_adapter_rejects_invalid_params_without_state_writes(adapter: Any) -> None:
    memory = Memory()
    op = adapter.manifest.ops[0]
    invalid_request = (
        {"extra": "not-allowed"} if adapter.manifest.name in {"ha", "cam", "autoglm"} else {}
    )

    handoff = await adapter.dispatch(op.name, invalid_request, _ctx(adapter, op))

    assert handoff.outcome == "failed"
    assert handoff.content["error"] == "invalid_params"
    _assert_executor_boundary(handoff, memory)


async def test_cam_store_rejection_is_a_typed_failure_without_state_writes() -> None:
    adapter = CamAdapter(
        ScriptedFrameSource(
            Frame(
                payload=b"",
                media_type="image/jpeg",
                width=1280,
                height=720,
                captured_at=7.0,
            )
        ),
        MediaStore(),
    )
    memory = Memory()
    op = adapter.manifest.ops[0]

    handoff = await adapter.dispatch(op.name, {}, _ctx(adapter, op))

    assert handoff.outcome == "failed"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {"error": "media_store_rejected", "op": "snapshot"}
    _assert_executor_boundary(handoff, memory)


@pytest.mark.parametrize(
    ("adapter", "error"),
    (
        (SlowSim(latency=0.0, inject="timeout"), "adapter_timeout"),
        (SlowSim(latency=0.0, inject="transport"), "transport_error"),
        (SearchAdapter(_FailureTransport("timeout")), "timeout"),
        (SearchAdapter(_FailureTransport("transport")), "transport"),
    ),
    ids=("slow-timeout", "slow-transport", "search-timeout", "search-transport"),
)
async def test_adapter_timeouts_and_transport_failures_are_typed_unknowns(
    adapter: Any,
    error: str,
) -> None:
    memory = Memory()
    op = adapter.manifest.ops[0]

    handoff = await adapter.dispatch(
        op.name,
        _valid_request(adapter, op),
        _ctx(adapter, op),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["error"] == error
    _assert_executor_boundary(handoff, memory)
