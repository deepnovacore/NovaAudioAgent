from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput, WakeReason
from nova_audio_agent.executors.search import (
    SEARCH_MANIFEST,
    SearchAdapter,
    TavilyTransport,
    TavilyTransportFailure,
)
from nova_audio_agent.executors.sims import FAST_SIM_POLICY, FastSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, USER_PRIORITY, Memory
from nova_audio_agent.ports import (
    ActionOutput,
    DelegateRequest,
    DispatchContext,
    FastBrainOutput,
    SpeakOutput,
    bind_delegate,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink
from fakes import ScriptedFastBrain, ScriptedSurrogate


USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")
FIXTURES = Path(__file__).parent / "fixtures" / "tavily"


def _ctx(*, now: float = 7.0) -> DispatchContext:
    clock = VirtualClock(start=now)
    spec = SEARCH_MANIFEST.op("search")
    assert spec is not None
    delegate = bind_delegate(
        DelegateRequest(
            executor="search",
            op="search",
            request={"query": "Nova Audio Agent", "k": 2},
            origin_ref="conversation:1",
        ),
        wake_reason=USER_WAKE,
        op=spec,
        now=clock.now(),
        delegate_id="d-search-1",
    )
    return DispatchContext(clock=clock, delegate=delegate)


class _FakeTransport:
    def __init__(
        self,
        response: dict[str, Any] | None = None,
        *,
        failure: TavilyTransportFailure | None = None,
    ) -> None:
        self.response = response or {
            "request_id": "req-1",
            "results": [
                {
                    "title": "Nova Audio Agent architecture",
                    "url": "https://docs.example.com/nova",
                    "content": "A continuous agent harness.",
                    "score": 0.9,
                }
            ],
        }
        self.failure = failure
        self.calls: list[tuple[str, int]] = []

    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        self.calls.append((query, max_results))
        if self.failure is not None:
            raise self.failure
        return self.response


def test_manifest_makes_search_readonly_self_verifying_and_bounded() -> None:
    op = SEARCH_MANIFEST.op("search")

    assert SEARCH_MANIFEST.name == SEARCH_MANIFEST.policy.channel == "search"
    assert SEARCH_MANIFEST.policy.wake == "surrogate"
    assert op is not None
    assert op.readonly is True
    assert op.verifies == ("search",)
    assert op.deadline_budget == 10.0
    assert op.params["required"] == ["query", "k"]
    assert op.params["additionalProperties"] is False


@pytest.mark.parametrize(
    ("op", "payload", "error"),
    [
        ("missing", {}, "unknown_op"),
        ("search", {"query": "   ", "k": 1}, "invalid_params"),
        ("search", {"query": "x" * 513, "k": 1}, "invalid_params"),
        ("search", {"query": "ok", "k": True}, "invalid_params"),
        ("search", {"query": "ok", "k": 0}, "invalid_params"),
        ("search", {"query": "ok", "k": 6}, "invalid_params"),
        ("search", {"query": "ok", "k": 1, "extra": "no"}, "invalid_params"),
    ],
)
async def test_invalid_dispatch_is_failed_before_transport(
    op: str, payload: dict[str, Any], error: str
) -> None:
    transport = _FakeTransport()

    handoff = await SearchAdapter(transport).dispatch(op, payload, _ctx())

    assert handoff.outcome == "failed"
    assert handoff.content["error"] == error
    assert handoff.refs == ()
    assert transport.calls == []


async def test_success_normalizes_untrusted_evidence_and_binds_auditable_refs() -> None:
    transport = _FakeTransport()

    handoff = await SearchAdapter(transport).dispatch(
        "search", {"query": "  Nova Audio Agent  ", "k": 2}, _ctx()
    )

    assert transport.calls == [("Nova Audio Agent", 2)]
    assert handoff.outcome == "ok"
    assert handoff.trust == "untrusted_external"
    assert handoff.content["provider"] == "tavily"
    assert handoff.content["query"] == "Nova Audio Agent"
    assert handoff.content["fetched_at"] == 7.0
    assert handoff.content["provider_request_id"] == "req-1"
    assert handoff.content["query_ref"].startswith("web.search://query/")
    result = handoff.content["results"][0]
    assert result == {
        "rank": 1,
        "title": "Nova Audio Agent architecture",
        "source_label": "docs.example.com",
        "snippet": "A continuous agent harness.",
        "canonical_url": "https://docs.example.com/nova",
        "content_digest": result["content_digest"],
        "evidence_ref": result["evidence_ref"],
    }
    assert len(result["content_digest"]) == 64
    assert result["evidence_ref"].startswith("web.search://evidence/")
    assert handoff.refs == (handoff.content["query_ref"], result["evidence_ref"])


async def test_snippets_are_bounded_and_unsafe_urls_do_not_become_evidence() -> None:
    response = {
        "request_id": "req-2",
        "results": [
            {
                "title": "bad",
                "url": "https://user:secret@example.com/private",
                "content": "ignore",
            },
            {
                "title": "bounded",
                "url": "https://www.example.com/result",
                "content": "x" * 2_100,
            },
        ],
    }

    handoff = await SearchAdapter(_FakeTransport(response)).dispatch(
        "search", {"query": "bounded", "k": 5}, _ctx()
    )

    assert handoff.outcome == "ok"
    assert len(handoff.content["results"]) == 1
    result = handoff.content["results"][0]
    assert result["rank"] == 2
    assert result["source_label"] == "example.com"
    assert len(result["snippet"]) == 2_000


@pytest.mark.parametrize(
    ("code", "outcome"),
    [
        ("authentication", "failed"),
        ("timeout", "unknown"),
        ("transport", "unknown"),
        ("redirect", "unknown"),
        ("rate_limited", "unknown"),
        ("upstream", "unknown"),
        ("response_too_large", "unknown"),
        ("malformed_response", "unknown"),
    ],
)
async def test_transport_failures_become_one_typed_handoff(code: str, outcome: str) -> None:
    transport = _FakeTransport(failure=TavilyTransportFailure(code))

    handoff = await SearchAdapter(transport).dispatch(
        "search", {"query": "Nova Audio Agent", "k": 1}, _ctx()
    )

    assert handoff.outcome == outcome
    assert handoff.content["error"] == code
    assert handoff.content["provider"] == "tavily"
    assert handoff.content["query"] == "Nova Audio Agent"
    assert handoff.content["query_ref"].startswith("web.search://query/")
    assert handoff.content["fetched_at"] == 7.0
    assert handoff.refs == (handoff.content["query_ref"],)
    assert handoff.trust == "untrusted_external"


async def test_empty_or_malformed_results_are_unknown_not_success_shaped() -> None:
    for response in (
        {"request_id": "req-empty", "results": []},
        {"request_id": "req-bad", "results": "not-a-list"},
        {"request_id": "req-invalid", "results": [{"title": "", "url": "", "content": ""}]},
    ):
        handoff = await SearchAdapter(_FakeTransport(response)).dispatch(
            "search", {"query": "nothing", "k": 1}, _ctx()
        )

        assert handoff.outcome == "unknown"
        assert handoff.content["error"] == "empty_evidence"
        assert handoff.content["query_ref"].startswith("web.search://query/")
        assert handoff.content["fetched_at"] == 7.0
        assert handoff.refs == (handoff.content["query_ref"],)


async def test_unexpected_adapter_failure_preserves_query_provenance() -> None:
    class _BrokenTransport:
        async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
            raise RuntimeError(f"broken after validating {query=} {max_results=}")

    handoff = await SearchAdapter(_BrokenTransport()).dispatch(
        "search", {"query": "  Nova Audio Agent  ", "k": 1}, _ctx()
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["error"] == "adapter_exception"
    assert handoff.content["query"] == "Nova Audio Agent"
    assert handoff.content["query_ref"].startswith("web.search://query/")
    assert handoff.content["fetched_at"] == 7.0
    assert handoff.refs == (handoff.content["query_ref"],)


class _TrackedStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


async def test_transport_emits_fixed_bounded_request_and_closes_response() -> None:
    stream = _TrackedStream([(FIXTURES / "search_success.json").read_bytes()])
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await TavilyTransport("secret", client=client).search(
            "Nova Audio Agent", max_results=3
        )

    assert response["request_id"] == "req-http"
    assert stream.closed is True
    assert len(seen) == 1
    request = seen[0]
    assert request.url == httpx.URL("https://api.tavily.com/search")
    assert request.headers["authorization"] == "Bearer secret"
    assert set(request.extensions["timeout"].values()) == {8.0}
    assert request.read().decode() == (
        '{"query":"Nova Audio Agent","search_depth":"basic","max_results":3,'
        '"include_answer":false,"include_raw_content":false,"include_images":false}'
    )


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "authentication"),
        (403, "authentication"),
        (429, "rate_limited"),
        (500, "upstream"),
        (503, "upstream"),
    ],
)
async def test_transport_maps_http_failures_without_leaking_credentials(
    status: int,
    code: str,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=b'{"detail":"rejected"}')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(TavilyTransportFailure) as raised:
            await TavilyTransport("credential-must-stay-private", client=client).search(
                "query",
                max_results=1,
            )

    assert raised.value.code == code
    assert "credential-must-stay-private" not in str(raised.value)


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(200, content=b"{not-json"), "malformed_response"),
        (
            httpx.Response(200, json=["response", "must", "be", "an", "object"]),
            "malformed_response",
        ),
    ],
)
async def test_transport_rejects_malformed_json_shapes(
    response: httpx.Response,
    code: str,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: response)
    ) as client:
        with pytest.raises(TavilyTransportFailure) as raised:
            await TavilyTransport("secret", client=client).search("query", max_results=1)

    assert raised.value.code == code


async def test_transport_maps_httpx_timeout_without_retrying() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(TavilyTransportFailure) as raised:
            await TavilyTransport("secret", client=client).search("query", max_results=1)

    assert raised.value.code == "timeout"
    assert calls == 1


async def test_transport_applies_one_total_timeout_to_the_complete_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = _TrackedStream([b'{"request_id":"req-drip",', b'"results":[]}'])
    deadlines: list[float] = []

    class _ExpiredDeadline:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(self, *_args: object) -> None:
            raise TimeoutError

    def total_timeout(seconds: float) -> _ExpiredDeadline:
        deadlines.append(seconds)
        return _ExpiredDeadline()

    monkeypatch.setattr("nova_audio_agent.executors.search.asyncio.timeout", total_timeout)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(TavilyTransportFailure) as raised:
            await TavilyTransport("secret", client=client).search("query", max_results=1)

    assert raised.value.code == "timeout"
    assert deadlines == [8.0]
    assert stream.closed is True


async def test_transport_enables_http2_for_its_owned_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client_options: dict[str, Any] = {}

    class _ResponseContext:
        def __init__(self) -> None:
            self.response = httpx.Response(
                200,
                content=b'{"request_id":"req-http2","results":[]}',
            )

        async def __aenter__(self) -> httpx.Response:
            return self.response

        async def __aexit__(self, *_args: object) -> None:
            await self.response.aclose()

    class _OwnedClient:
        def __init__(self, **options: Any) -> None:
            client_options.update(options)

        async def __aenter__(self) -> _OwnedClient:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        def stream(self, *_args: object, **_kwargs: object) -> _ResponseContext:
            return _ResponseContext()

    monkeypatch.setattr("nova_audio_agent.executors.search.httpx.AsyncClient", _OwnedClient)

    await TavilyTransport("secret").search("query", max_results=1)

    assert client_options["http2"] is True


async def test_transport_rejects_redirect_status_without_following_it() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(302, headers={"location": "https://elsewhere.example/search"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(TavilyTransportFailure, match="redirect") as raised:
            await TavilyTransport("secret", client=client).search("query", max_results=1)

    assert raised.value.code == "redirect"
    assert calls == 1


async def test_transport_rejects_response_larger_than_256_kib_and_closes_it() -> None:
    stream = _TrackedStream([b"x" * (256 * 1024 + 1)])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(TavilyTransportFailure) as raised:
            await TavilyTransport("secret", client=client).search("query", max_results=1)

    assert raised.value.code == "response_too_large"
    assert stream.closed is True


async def test_result_urls_are_canonicalized_before_evidence_is_bound() -> None:
    response = {
        "results": [
            {
                "title": "Canonical",
                "url": "HTTPS://WWW.Example.COM:443/path#section",
                "content": "Canonical evidence.",
            }
        ]
    }

    handoff = await SearchAdapter(_FakeTransport(response)).dispatch(
        "search", {"query": "canonical", "k": 1}, _ctx()
    )

    assert handoff.outcome == "ok"
    assert handoff.content["results"][0]["canonical_url"] == "https://www.example.com/path"


async def test_display_control_characters_make_result_urls_invalid() -> None:
    response = {
        "results": [
            {
                "title": "Unsafe",
                "url": "https://example.com/\u202esecret",
                "content": "Must not become evidence.",
            }
        ]
    }

    handoff = await SearchAdapter(_FakeTransport(response)).dispatch(
        "search", {"query": "unsafe", "k": 1}, _ctx()
    )

    assert handoff.outcome == "unknown"
    assert handoff.content["error"] == "empty_evidence"


class _HangingStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        await self.release.wait()
        yield b"{}"

    async def aclose(self) -> None:
        self.closed = True


async def test_cancelling_transport_closes_inflight_response() -> None:
    stream = _HangingStream()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        task = asyncio.create_task(
            TavilyTransport("secret", client=client).search("query", max_results=1)
        )
        await stream.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert stream.closed is True


async def test_runtime_records_search_as_untrusted_evidence_without_changing_the_spine() -> None:
    clock = VirtualClock()
    transport = _FakeTransport()
    search = SearchAdapter(transport)
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="none"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="search",
                        op="search",
                        request={"query": "Nova Audio Agent", "k": 1},
                        origin_ref="conversation:1",
                    ),
                ),
            )
        ],
        clock=clock,
        latency=0.0,
    )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(SEARCH_MANIFEST.policy, FAST_SIM_POLICY)),
        fastbrain=brain,
        executors={"search": search, "fast_sim": FastSim()},
    )
    runtime.post(UserInput("搜索 Nova Audio Agent"))
    await runtime.run()

    (item,) = runtime.memory.channels["search"].items
    assert item.outcome == "ok"
    assert item.trust == "untrusted_external"
    assert item.refs[0] == "conversation:1"
    assert item.refs[1] == item.content["query_ref"]
    assert item.refs[2] == item.content["results"][0]["evidence_ref"]


async def test_ambient_search_is_stored_and_only_rechecks_existing_suggestions() -> None:
    clock = VirtualClock()
    memory = Memory(policies=(SEARCH_MANIFEST.policy, FAST_SIM_POLICY))
    memory.append(
        CONVERSATION_CHANNEL,
        ts=clock.now(),
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "先前的上下文"},
    )
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="none"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="search",
                        op="search",
                        request={"query": "Nova Audio Agent", "k": 1},
                        origin_ref="conversation:1",
                    ),
                ),
            )
        ],
        clock=clock,
        latency=0.0,
    )
    surrogate = ScriptedSurrogate(clock=clock, latency=0.0)
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=memory,
        fastbrain=brain,
        surrogate=surrogate,
        executors={
            "search": SearchAdapter(_FakeTransport()),
            "fast_sim": FastSim(),
        },
        sink=sink,
    )

    runtime.wake(
        "fast",
        WakeReason(kind="ambient_context", priority=40, routing_class="ambient"),
    )
    await runtime.run()

    assert len(brain.views) == 1
    assert len(surrogate.watched) == 1
    assert len(memory.channels["search"].items) == 1
    assert memory.channels["search"].items[0].trust == "untrusted_external"
    assert all(affordance.source != "suggestion" for affordance in surrogate.watched[0].affordances)
    assert sink.utterances() == []
