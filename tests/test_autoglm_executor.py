from __future__ import annotations

import base64
import struct
import zlib
from typing import Any

import httpx
import pytest

import nova_audio_agent.executors.autoglm as autoglm
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.autoglm import (
    AUTOGLM_MANIFEST,
    BROWSE,
    AutoGlmAdapter,
    AutoGlmWdaClient,
    WdaFailure,
    WdaScreenshot,
)
from nova_audio_agent.executors.autoglm_protocol import AutoGlmWorkerResult
from nova_audio_agent.executors.autoglm_transport import AutoGlmTransportFailure
from nova_audio_agent.media import MediaStore
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.events import Deadline


def _ctx(op: str, request: dict[str, Any] | None = None) -> DispatchContext:
    clock = VirtualClock(start=7.0)
    spec = AUTOGLM_MANIFEST.op(op)
    assert spec is not None
    request = request or ({"query": "Nova Audio Agent"} if op == "browse" else {})
    delegate = bind_delegate(
        DelegateRequest(
            executor="autoglm",
            op=op,
            request=request,
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=spec,
        now=clock.now(),
        delegate_id=f"d-autoglm-{op}",
    )
    return DispatchContext(clock=clock, delegate=delegate)


class _Worker:
    def __init__(
        self,
        result: AutoGlmWorkerResult | None = None,
        *,
        failure: BaseException | None = None,
    ) -> None:
        self.result = result or _result("completed", "completed")
        self.failure = failure
        self.calls: list[tuple[str, object]] = []

    async def run_browse(self, query: str, *, deadline: object) -> AutoGlmWorkerResult:
        self.calls.append((query, deadline))
        if self.failure is not None:
            raise self.failure
        return self.result


class _Wda:
    def __init__(
        self,
        *,
        bundle_id: str = "com.apple.mobilesafari",
        screenshot: WdaScreenshot | None = None,
        active_failure: WdaFailure | None = None,
        screenshot_failure: WdaFailure | None = None,
    ) -> None:
        self.bundle_id = bundle_id
        self.frame = screenshot or WdaScreenshot(
            payload=_png(2, 3),
            media_type="image/png",
            width=2,
            height=3,
        )
        self.active_failure = active_failure
        self.screenshot_failure = screenshot_failure
        self.active_calls = 0
        self.screenshot_calls = 0

    async def active_bundle_id(self) -> str:
        self.active_calls += 1
        if self.active_failure is not None:
            raise self.active_failure
        return self.bundle_id

    async def screenshot(self) -> WdaScreenshot:
        self.screenshot_calls += 1
        if self.screenshot_failure is not None:
            raise self.screenshot_failure
        return self.frame


def _result(outcome: str, code: str) -> AutoGlmWorkerResult:
    return AutoGlmWorkerResult(
        outcome=outcome,  # type: ignore[arg-type]
        code=code,
        effect_verification="not_performed",
        events=(
            {"type": "status", "state": "started"},
            {"type": "action", "kind": "tap"},
        ),
    )


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, value: bytes) -> bytes:
        return (
            struct.pack(">I", len(value))
            + kind
            + value
            + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        )

    rows = b"".join(b"\x00" + b"\x00\x00\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _monochrome_png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, value: bytes) -> bytes:
        return (
            struct.pack(">I", len(value))
            + kind
            + value
            + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
        )

    row = b"\x00" + b"\x00" * ((width + 7) // 8)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def test_manifest_exposes_only_bounded_browse_and_readonly_screenshot() -> None:
    browse = AUTOGLM_MANIFEST.op("browse")
    screenshot = AUTOGLM_MANIFEST.op("screenshot")

    assert AUTOGLM_MANIFEST.name == AUTOGLM_MANIFEST.policy.channel == "autoglm"
    assert AUTOGLM_MANIFEST.policy.wake == "fast"
    assert tuple(op.name for op in AUTOGLM_MANIFEST.ops) == ("browse", "screenshot")
    assert browse is not None
    assert browse.readonly is False
    assert browse.deadline_budget == 180.0
    assert browse.sensitive_params == ("query",)
    assert browse.params == {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200,
                "description": "要在 Safari 中搜索的简短查询",
            }
        },
        "required": ["query"],
        "additionalProperties": False,
    }
    assert screenshot is not None
    assert screenshot.readonly is True
    assert screenshot.verifies == ()
    assert screenshot.deadline_budget == 7.0
    assert screenshot.params["additionalProperties"] is False


@pytest.mark.parametrize(
    ("op", "payload", "error"),
    (
        ("missing", {}, "unknown_op"),
        ("browse", {}, "invalid_params"),
        ("browse", {"query": "   "}, "invalid_params"),
        ("browse", {"query": "x" * 201}, "invalid_params"),
        ("browse", {"query": "ok", "extra": "no"}, "invalid_params"),
        ("screenshot", {"extra": "no"}, "invalid_params"),
    ),
)
async def test_invalid_dispatch_fails_before_wda_or_worker(
    op: str,
    payload: dict[str, Any],
    error: str,
) -> None:
    worker = _Worker()
    wda = _Wda()

    handoff = await AutoGlmAdapter(worker, wda, MediaStore()).dispatch(
        op,
        payload,
        _ctx("browse"),
    )

    assert handoff.outcome == "failed"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {"error": error, "op": op}
    assert worker.calls == []
    assert wda.active_calls == 0
    assert wda.screenshot_calls == 0


async def test_browse_preflight_unavailability_is_not_an_app_policy_block() -> None:
    worker = _Worker()
    wda = _Wda(active_failure=WdaFailure("transport"))

    handoff = await AutoGlmAdapter(worker, wda, MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "browse"}
    assert worker.calls == []


async def test_browse_unresolved_active_app_is_unavailable_not_disallowed() -> None:
    class _UnresolvedWda(_Wda):
        async def active_bundle_id(self) -> Any:
            self.active_calls += 1
            return None

    worker = _Worker()

    handoff = await AutoGlmAdapter(  # type: ignore[arg-type]
        worker,
        _UnresolvedWda(),
        MediaStore(),
    ).dispatch("browse", {"query": "Nova Audio Agent"}, _ctx("browse"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "browse"}
    assert worker.calls == []


async def test_browse_known_disallowed_app_is_a_distinct_refusal() -> None:
    worker = _Worker()
    wda = _Wda(bundle_id="com.apple.Maps")

    handoff = await AutoGlmAdapter(worker, wda, MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "current_app_not_allowed", "op": "browse"}
    assert worker.calls == []


async def test_browse_completion_returns_bounded_execution_evidence() -> None:
    worker = _Worker(_result("completed", "completed"))
    adapter = AutoGlmAdapter(worker, _Wda(), MediaStore())
    ctx = _ctx("browse")

    handoff = await adapter.dispatch(
        "browse",
        {"query": "  Nova Audio Agent  "},
        ctx,
    )

    assert len(worker.calls) == 1
    query, deadline = worker.calls[0]
    assert query == "Nova Audio Agent"
    assert getattr(deadline, "expires_at") == 187.0
    assert getattr(deadline, "clock") is ctx.clock
    assert deadline.remaining() == 180.0  # type: ignore[attr-defined]
    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {
        "op": "browse",
        "code": "completed",
        "effect_verification": "not_performed",
        "events": [
            {"type": "status", "state": "started"},
            {"type": "action", "kind": "tap"},
        ],
    }
    assert handoff.refs == ()


@pytest.mark.parametrize(
    ("result", "outcome"),
    (
        (_result("blocked", "sensitive_action"), "failed"),
        (_result("blocked", "takeover_requested"), "failed"),
        (_result("failed", "max_steps_reached"), "unknown"),
        (_result("failed", "wda_unavailable"), "unknown"),
    ),
)
async def test_browse_worker_outcomes_preserve_bounded_code_and_uncertainty(
    result: AutoGlmWorkerResult,
    outcome: str,
) -> None:
    handoff = await AutoGlmAdapter(_Worker(result), _Wda(), MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == outcome
    assert handoff.content["error"] == result.code
    assert handoff.content["effect_verification"] == "not_performed"
    assert handoff.content["events"] == list(result.events)
    assert "query" not in handoff.content


async def test_browse_transport_failure_after_start_is_unknown_without_retry() -> None:
    worker = _Worker(failure=AutoGlmTransportFailure("timeout", worker_started=True))

    handoff = await AutoGlmAdapter(worker, _Wda(), MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content == {
        "error": "timeout",
        "op": "browse",
        "effect_verification": "not_performed",
    }
    assert len(worker.calls) == 1
    assert worker.calls[0][0] == "Nova Audio Agent"


@pytest.mark.parametrize("code", ("spawn_failed", "timeout"))
async def test_browse_pre_spawn_transport_failure_is_failed(code: str) -> None:
    worker = _Worker(
        failure=AutoGlmTransportFailure(code, worker_started=False),
    )

    handoff = await AutoGlmAdapter(worker, _Wda(), MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": code, "op": "browse"}
    assert len(worker.calls) == 1


async def test_unexpected_worker_exception_is_a_typed_unknown() -> None:
    worker = _Worker(failure=RuntimeError("private model detail"))

    handoff = await AutoGlmAdapter(worker, _Wda(), MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content == {
        "error": "adapter_exception",
        "op": "browse",
        "effect_verification": "not_performed",
    }


async def test_malformed_worker_return_cannot_escape_dispatch() -> None:
    class _MalformedWorker:
        async def run_browse(self, query: str, *, deadline: object) -> object:
            del query, deadline
            return object()

    handoff = await AutoGlmAdapter(  # type: ignore[arg-type]
        _MalformedWorker(),
        _Wda(),
        MediaStore(),
    ).dispatch("browse", {"query": "Nova Audio Agent"}, _ctx("browse"))

    assert handoff.outcome == "unknown"
    assert handoff.content == {
        "error": "adapter_exception",
        "op": "browse",
        "effect_verification": "not_performed",
    }


@pytest.mark.parametrize(
    "event",
    (
        {"type": "action", "kind": "tap", "screenshot_base64": "private-pixels"},
        {"type": "status", "state": "running", "thinking": "private-model-output"},
        {"type": "error", "code": "authentication", "api_key": "private-credential"},
        {"type": "action", "kind": "tap", "message": "private-model-output"},
    ),
    ids=("pixels", "thinking", "credential", "extra-model-field"),
)
async def test_injected_worker_events_are_revalidated_before_handoff(
    event: dict[str, str],
) -> None:
    worker = _Worker(
        AutoGlmWorkerResult(
            outcome="completed",
            code="completed",
            effect_verification="not_performed",
            events=(event,),
        )
    )

    handoff = await AutoGlmAdapter(worker, _Wda(), MediaStore()).dispatch(
        "browse",
        {"query": "Nova Audio Agent"},
        _ctx("browse"),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content == {
        "error": "adapter_exception",
        "op": "browse",
        "effect_verification": "not_performed",
    }
    assert "private-" not in repr(handoff)


def test_browse_query_is_redacted_from_durable_deadline_evidence() -> None:
    adapter = AutoGlmAdapter(_Worker(), _Wda(), MediaStore())
    clock = VirtualClock(start=7.0)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(AUTOGLM_MANIFEST.policy,)),
        executors={"autoglm": adapter},
    )
    delegate = bind_delegate(
        DelegateRequest(
            executor="autoglm",
            op="browse",
            request={"query": "private search terms"},
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=BROWSE,
        now=clock.now(),
        delegate_id="d-autoglm-deadline",
    )
    runtime.delegates.dispatch(delegate)

    runtime._apply_deadline(Deadline(delegate_id=delegate.delegate_id, ts=187.0))

    observation = runtime.memory.channels["autoglm"].items[-1]
    assert observation.content == {
        "error": "deadline_exceeded",
        "op": "browse",
        "request": {"query": "[REDACTED]"},
    }
    assert "private search terms" not in repr(observation)


async def test_screenshot_stores_png_and_returns_only_a_media_reference() -> None:
    payload = _png(2, 3)
    store = MediaStore(id_factory=lambda: "phone")
    adapter = AutoGlmAdapter(
        _Worker(),
        _Wda(
            screenshot=WdaScreenshot(
                payload=payload,
                media_type="image/png",
                width=2,
                height=3,
            )
        ),
        store,
    )

    handoff = await adapter.dispatch("screenshot", {}, _ctx("screenshot"))

    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content == {
        "op": "screenshot",
        "media_ref": "media:phone",
        "digest": "7998a64c8a417048cc0f12d5b82a5e3529843df87ba58da6d69f9ab38fbe187a",
        "media_type": "image/png",
        "width": 2,
        "height": 3,
        "captured_at": 7.0,
    }
    assert handoff.refs == ("media:phone",)
    assert store.peek("media:phone") is not None
    assert store.peek("media:phone").payload == payload  # type: ignore[union-attr]
    assert base64.b64encode(payload).decode() not in repr(handoff)


async def test_screenshot_wda_failure_is_a_conclusive_read_failure() -> None:
    adapter = AutoGlmAdapter(
        _Worker(),
        _Wda(screenshot_failure=WdaFailure("malformed_response")),
        MediaStore(),
    )

    handoff = await adapter.dispatch("screenshot", {}, _ctx("screenshot"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "screenshot"}


async def test_screenshot_malformed_wda_return_is_unavailable() -> None:
    class _MalformedWda(_Wda):
        async def screenshot(self) -> Any:
            self.screenshot_calls += 1
            return None

    handoff = await AutoGlmAdapter(  # type: ignore[arg-type]
        _Worker(),
        _MalformedWda(),
        MediaStore(),
    ).dispatch("screenshot", {}, _ctx("screenshot"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "screenshot"}


async def test_screenshot_store_rejection_is_typed_without_leaking_pixels() -> None:
    adapter = AutoGlmAdapter(_Worker(), _Wda(), MediaStore(max_bytes=1))

    handoff = await adapter.dispatch("screenshot", {}, _ctx("screenshot"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "media_store_rejected", "op": "screenshot"}


@pytest.mark.parametrize(
    "url",
    (
        "https://127.0.0.1:8100",
        "http://127.0.0.1:8101",
        "http://example.com:8100",
        "http://user@localhost:8100",
        "http://localhost:8100/",
        "http://localhost:8100/wda",
        "http://localhost:8100?redirect=example.com",
    ),
)
def test_wda_client_rejects_every_non_exact_loopback_endpoint(url: str) -> None:
    with pytest.raises(ValueError, match="invalid_wda_url"):
        AutoGlmWdaClient(url)


async def test_wda_client_reads_active_app_and_decodes_bounded_png() -> None:
    payload = _png(2, 3)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/wda/activeAppInfo":
            return httpx.Response(
                200,
                json={
                    "value": {"bundleId": "com.apple.mobilesafari"},
                    "sessionId": "wda-session",
                },
            )
        if request.url.path == "/screenshot":
            return httpx.Response(
                200,
                json={
                    "value": base64.b64encode(payload).decode(),
                    "sessionId": "wda-session",
                },
            )
        raise AssertionError(request.url)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        wda = AutoGlmWdaClient("http://localhost:8100", client=client)
        bundle_id = await wda.active_bundle_id()
        frame = await wda.screenshot()

    assert bundle_id == "com.apple.mobilesafari"
    assert frame == WdaScreenshot(
        payload=payload,
        media_type="image/png",
        width=2,
        height=3,
    )
    assert [(request.method, request.url.path) for request in requests] == [
        ("GET", "/wda/activeAppInfo"),
        ("GET", "/screenshot"),
    ]


@pytest.mark.parametrize(
    "payload",
    (
        _png(2, 3)[:24],
        _monochrome_png(4097, 4097),
    ),
    ids=("truncated", "too-many-pixels"),
)
async def test_invalid_png_never_enters_media_store(payload: bytes) -> None:
    store = MediaStore(id_factory=lambda: "must-not-be-used")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={"value": base64.b64encode(payload).decode()},
            )
        )
    ) as client:
        adapter = AutoGlmAdapter(
            _Worker(),
            AutoGlmWdaClient("http://127.0.0.1:8100", client=client),
            store,
        )
        handoff = await adapter.dispatch("screenshot", {}, _ctx("screenshot"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "screenshot"}
    assert store.total_bytes == 0


async def test_wda_client_ignores_environment_proxies_for_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={"value": {"bundleId": "com.apple.mobilesafari"}},
            )
        )
    )
    constructor_calls: list[dict[str, Any]] = []

    class _OwnedClient:
        async def __aenter__(self) -> httpx.AsyncClient:
            return real_client

        async def __aexit__(self, *args: object) -> None:
            del args
            await real_client.aclose()

    def client_factory(**kwargs: Any) -> _OwnedClient:
        constructor_calls.append(kwargs)
        return _OwnedClient()

    monkeypatch.setattr(autoglm.httpx, "AsyncClient", client_factory)

    assert (
        await AutoGlmWdaClient("http://127.0.0.1:8100").active_bundle_id()
        == "com.apple.mobilesafari"
    )
    assert constructor_calls == [{"trust_env": False}]


@pytest.mark.parametrize(
    ("endpoint", "response"),
    (
        (
            "screenshot",
            httpx.Response(302, headers={"location": "http://example.com/private"}),
        ),
        ("active", httpx.Response(200, json={"value": {"bundleId": ""}})),
        ("screenshot", httpx.Response(200, json={"value": "not-base64"})),
    ),
)
async def test_wda_client_rejects_redirects_and_malformed_observations(
    endpoint: str,
    response: httpx.Response,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: response)
    ) as client:
        wda = AutoGlmWdaClient("http://127.0.0.1:8100", client=client)
        with pytest.raises(WdaFailure):
            if endpoint == "active":
                await wda.active_bundle_id()
            else:
                await wda.screenshot()


@pytest.mark.parametrize("bundle_id", (" com.apple.mobilesafari", "com.apple.\x00Safari"))
async def test_wda_client_rejects_bundle_ids_with_whitespace_or_control_characters(
    bundle_id: str,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"value": {"bundleId": bundle_id}})
        )
    ) as client:
        with pytest.raises(WdaFailure, match="malformed_response"):
            await AutoGlmWdaClient("http://127.0.0.1:8100", client=client).active_bundle_id()


async def test_adapter_treats_malformed_nonempty_bundle_as_wda_unavailable() -> None:
    handoff = await AutoGlmAdapter(
        _Worker(), _Wda(bundle_id="com.apple. Safari"), MediaStore()
    ).dispatch("browse", {"query": "Nova Audio Agent"}, _ctx("browse"))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "wda_unavailable", "op": "browse"}
