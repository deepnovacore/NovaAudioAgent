from __future__ import annotations

from typing import Any

import httpx
import pytest

from fakes import ScriptedFastBrain
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput, WakeReason
from nova_audio_agent.executors.home_assistant import (
    HOME_ASSISTANT_MANIFEST,
    HomeAssistantAdapter,
    HomeAssistantTransport,
    HomeAssistantTransportFailure,
)
from nova_audio_agent.memory import Memory
from nova_audio_agent.ports import (
    ActionOutput,
    DelegateRequest,
    DispatchContext,
    FastBrainOutput,
    SpeakOutput,
    bind_delegate,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.tool_schema import compile_tool_schema


class _Clock:
    def __init__(self, now: float = 12.5) -> None:
        self._now = now

    def now(self) -> float:
        return self._now

    async def sleep(self, duration: float) -> None:
        self._now += duration


class _Transport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def get_state(self, entity_id: str) -> dict[str, Any]:
        self.calls.append(("get_state", entity_id))
        return {
            "entity_id": entity_id,
            "state": "on",
            "attributes": {
                "brightness": 128,
                "color_temp_kelvin": 3000,
                "min_color_temp_kelvin": 1700,
                "max_color_temp_kelvin": 6500,
                "supported_color_modes": ["color_temp", "rgb"],
            },
            "last_changed": "2026-07-30T09:00:00+00:00",
            "last_updated": "2026-07-30T09:00:01+00:00",
        }

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        self.calls.append((service, dict(service_data)))
        return []


def _ctx(op_name: str, request: dict[str, Any]) -> DispatchContext:
    clock = _Clock()
    op = HOME_ASSISTANT_MANIFEST.op(op_name)
    assert op is not None
    delegate = bind_delegate(
        DelegateRequest(
            executor="ha",
            op=op_name,
            request=request,
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(
            kind="user_input",
            priority=100,
            routing_class="user_awaited",
        ),
        op=op,
        now=clock.now(),
        delegate_id=f"d-ha-{op_name}",
    )
    return DispatchContext(clock=clock, delegate=delegate)


def test_manifest_exposes_one_write_and_its_conclusive_read_probe() -> None:
    get_state = HOME_ASSISTANT_MANIFEST.op("get_state")
    set_light = HOME_ASSISTANT_MANIFEST.op("set_light")

    assert HOME_ASSISTANT_MANIFEST.name == "ha"
    assert get_state is not None
    assert get_state.readonly is True
    assert get_state.verifies == ("set_light",)
    assert get_state.deadline_budget == 8.0
    assert set_light is not None
    assert set_light.readonly is False
    assert set_light.deadline_budget == 8.0
    assert HOME_ASSISTANT_MANIFEST.policy.channel == "ha"


def test_compiled_manifest_schema_requires_one_business_light_field() -> None:
    compiled = compile_tool_schema((HOME_ASSISTANT_MANIFEST,))
    set_light = compiled.schemas[-1]["function"]["parameters"]

    assert set_light["anyOf"] == [
        {"required": ["power"]},
        {"required": ["brightness_pct"]},
        {"required": ["color_temp_kelvin"]},
    ]
    valid_call = {"power": "on", "origin_ref": "conversation:1"}
    business_call = dict(valid_call)
    business_call.pop("origin_ref")
    origin_only = {"origin_ref": "conversation:1"}
    alternatives = set_light["anyOf"]

    assert any(set(alternative["required"]) <= business_call.keys() for alternative in alternatives)
    assert not any(
        set(alternative["required"]) <= origin_only.keys() for alternative in alternatives
    )


async def test_get_state_returns_only_bounded_normalized_light_state() -> None:
    transport = _Transport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch("get_state", {}, _ctx("get_state", {}))

    assert handoff.outcome == "ok"
    assert handoff.trust == "trusted_system"
    assert handoff.content == {
        "op": "get_state",
        "entity_id": "light.bedside_lamp",
        "state": "on",
        "brightness_pct": 50,
        "color_temp_kelvin": 3000,
        "min_color_temp_kelvin": 1700,
        "max_color_temp_kelvin": 6500,
        "supported_color_modes": ["color_temp", "rgb"],
        "observed_at": 12.5,
    }
    assert transport.calls == [("get_state", "light.bedside_lamp")]


@pytest.mark.parametrize(
    ("brightness", "brightness_pct"),
    ((1, 1), (0, None), (256, None)),
)
async def test_raw_brightness_never_falls_below_the_set_light_schema(
    brightness: int,
    brightness_pct: int | None,
) -> None:
    transport = _Transport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    original_get_state = transport.get_state

    async def get_state(entity_id: str) -> dict[str, Any]:
        state = await original_get_state(entity_id)
        state["attributes"]["brightness"] = brightness
        return state

    transport.get_state = get_state
    handoff = await adapter.dispatch("get_state", {}, _ctx("get_state", {}))

    assert handoff.content["brightness_pct"] == brightness_pct


@pytest.mark.parametrize(
    ("input_request", "service", "service_data"),
    (
        ({"power": "on"}, "turn_on", {"entity_id": "light.bedside_lamp"}),
        (
            {"brightness_pct": 35},
            "turn_on",
            {"entity_id": "light.bedside_lamp", "brightness_pct": 35},
        ),
        (
            {"color_temp_kelvin": 2700},
            "turn_on",
            {"entity_id": "light.bedside_lamp", "color_temp_kelvin": 2700},
        ),
        (
            {"power": "on", "brightness_pct": 40, "color_temp_kelvin": 3200},
            "turn_on",
            {
                "entity_id": "light.bedside_lamp",
                "brightness_pct": 40,
                "color_temp_kelvin": 3200,
            },
        ),
        ({"power": "off"}, "turn_off", {"entity_id": "light.bedside_lamp"}),
    ),
)
async def test_set_light_routes_each_valid_request_to_the_bound_entity(
    input_request: dict[str, Any],
    service: str,
    service_data: dict[str, Any],
) -> None:
    transport = _Transport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch(
        "set_light",
        input_request,
        _ctx("set_light", input_request),
    )

    assert handoff.outcome == "ok"
    assert handoff.content == {
        "op": "set_light",
        "entity_id": "light.bedside_lamp",
        "service": service,
        "request": input_request,
        "accepted_at": 12.5,
        "effect_verification": "not_performed",
    }
    assert transport.calls == [(service, service_data)]


@pytest.mark.parametrize(
    "input_request",
    (
        {},
        {"power": "toggle"},
        {"power": "off", "brightness_pct": 50},
        {"power": "off", "color_temp_kelvin": 2700},
        {"brightness_pct": 0},
        {"brightness_pct": 101},
        {"brightness_pct": True},
        {"color_temp_kelvin": 999},
        {"color_temp_kelvin": 10001},
        {"color_temp_kelvin": True},
        {"entity_id": "light.somewhere_else", "power": "on"},
        {"power": "on", "transition": 2},
    ),
)
async def test_invalid_set_light_requests_fail_without_touching_home_assistant(
    input_request: dict[str, Any],
) -> None:
    transport = _Transport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch(
        "set_light",
        input_request,
        _ctx("set_light", input_request),
    )

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "invalid_params", "op": "set_light"}
    assert transport.calls == []


async def test_unknown_op_is_a_typed_failure_instead_of_an_exception() -> None:
    transport = _Transport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch("toggle", {}, _ctx("get_state", {}))

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "unknown_op", "op": "toggle"}
    assert transport.calls == []


class _TrackedStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


async def test_rest_transport_gets_the_bound_entity_with_fixed_headers_and_timeout() -> None:
    stream = _TrackedStream(
        [
            (
                b'{"entity_id":"light.bedside_lamp","state":"on",'
                b'"attributes":{},"last_changed":"x","last_updated":"y"}'
            )
        ]
    )
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await HomeAssistantTransport(
            "http://homeassistant.local:8123/",
            "private-token",
            client=client,
        ).get_state("light.bedside_lamp")

    assert response["state"] == "on"
    assert stream.closed is True
    assert len(seen) == 1
    request = seen[0]
    assert request.method == "GET"
    assert request.url == httpx.URL("http://homeassistant.local:8123/api/states/light.bedside_lamp")
    assert request.headers["authorization"] == "Bearer private-token"
    assert request.headers["content-type"] == "application/json"
    assert set(request.extensions["timeout"].values()) == {5.0}


@pytest.mark.parametrize(
    ("service", "service_data", "expected_body"),
    (
        (
            "turn_on",
            {"entity_id": "light.bedside_lamp", "brightness_pct": 35},
            '{"entity_id":"light.bedside_lamp","brightness_pct":35}',
        ),
        (
            "turn_off",
            {"entity_id": "light.bedside_lamp"},
            '{"entity_id":"light.bedside_lamp"}',
        ),
    ),
)
async def test_rest_transport_posts_only_the_two_fixed_light_services(
    service: str,
    service_data: dict[str, Any],
    expected_body: str,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await HomeAssistantTransport(
            "http://ha.test",
            "secret",
            client=client,
        ).call_service(service, service_data)

    assert response == []
    assert len(seen) == 1
    request = seen[0]
    assert request.method == "POST"
    assert request.url == httpx.URL(f"http://ha.test/api/services/light/{service}")
    assert request.read().decode() == expected_body


async def test_rest_transport_rejects_an_unapproved_service_before_network() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=[])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HomeAssistantTransportFailure) as raised:
            await HomeAssistantTransport(
                "http://ha.test",
                "secret",
                client=client,
            ).call_service(
                "toggle",
                {"entity_id": "light.bedside_lamp"},
            )

    assert raised.value.code == "provider_rejected"
    assert calls == 0


@pytest.mark.parametrize(
    ("status", "code"),
    (
        (302, "redirect"),
        (400, "provider_rejected"),
        (401, "authentication"),
        (403, "authentication"),
        (404, "not_found"),
        (405, "provider_rejected"),
        (429, "rate_limited"),
        (500, "upstream"),
        (503, "upstream"),
    ),
)
async def test_rest_transport_maps_status_without_leaking_the_token(
    status: int,
    code: str,
) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(status, content=b'{"message":"rejected"}')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HomeAssistantTransportFailure) as raised:
            await HomeAssistantTransport(
                "http://ha.test",
                "credential-must-stay-private",
                client=client,
            ).get_state("light.bedside_lamp")

    assert raised.value.code == code
    assert calls == 1
    assert "credential-must-stay-private" not in str(raised.value)


async def test_rest_transport_maps_timeout_without_retrying() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("timed out", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HomeAssistantTransportFailure) as raised:
            await HomeAssistantTransport(
                "http://ha.test",
                "secret",
                client=client,
            ).call_service("turn_on", {"entity_id": "light.bedside_lamp"})

    assert raised.value.code == "timeout"
    assert calls == 1


@pytest.mark.parametrize(
    ("method", "response"),
    (
        ("get_state", httpx.Response(200, content=b"{not-json")),
        ("get_state", httpx.Response(200, json=[])),
        ("call_service", httpx.Response(200, json={})),
    ),
)
async def test_rest_transport_rejects_malformed_response_shapes(
    method: str,
    response: httpx.Response,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _request: response)
    ) as client:
        transport = HomeAssistantTransport("http://ha.test", "secret", client=client)
        with pytest.raises(HomeAssistantTransportFailure) as raised:
            if method == "get_state":
                await transport.get_state("light.bedside_lamp")
            else:
                await transport.call_service(
                    "turn_on",
                    {"entity_id": "light.bedside_lamp"},
                )

    assert raised.value.code == "malformed_response"


async def test_rest_transport_rejects_oversized_response_and_closes_it() -> None:
    stream = _TrackedStream([b"x" * (64 * 1024 + 1)])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HomeAssistantTransportFailure) as raised:
            await HomeAssistantTransport(
                "http://ha.test",
                "secret",
                client=client,
            ).get_state("light.bedside_lamp")

    assert raised.value.code == "response_too_large"
    assert stream.closed is True


class _FailingTransport:
    def __init__(self, failure: Exception) -> None:
        self.failure = failure
        self.calls = 0

    async def get_state(self, entity_id: str) -> dict[str, Any]:
        del entity_id
        self.calls += 1
        raise self.failure

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        del service, service_data
        self.calls += 1
        raise self.failure


@pytest.mark.parametrize(
    ("code", "outcome"),
    (
        ("authentication", "failed"),
        ("not_found", "failed"),
        ("provider_rejected", "failed"),
        ("timeout", "unknown"),
        ("transport", "unknown"),
        ("redirect", "unknown"),
        ("rate_limited", "unknown"),
        ("upstream", "unknown"),
        ("response_too_large", "unknown"),
        ("malformed_response", "unknown"),
    ),
)
async def test_adapter_turns_transport_failures_into_one_credential_free_handoff(
    code: str,
    outcome: str,
) -> None:
    transport = _FailingTransport(HomeAssistantTransportFailure(code))
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch(
        "set_light",
        {"brightness_pct": 35},
        _ctx("set_light", {"brightness_pct": 35}),
    )

    assert handoff.outcome == outcome
    assert handoff.content == {"error": code, "op": "set_light"}
    assert handoff.trust == "trusted_system"
    assert transport.calls == 1


async def test_adapter_hides_unexpected_exception_details() -> None:
    transport = _FailingTransport(RuntimeError("crashed with private-token"))
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")

    handoff = await adapter.dispatch("get_state", {}, _ctx("get_state", {}))

    assert handoff.outcome == "unknown"
    assert handoff.content == {"error": "adapter_exception", "op": "get_state"}
    assert "private-token" not in str(handoff)
    assert transport.calls == 1


class _ProbeTransport:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get_state(self, entity_id: str) -> dict[str, Any]:
        self.calls.append("get_state")
        return {
            "entity_id": entity_id,
            "state": "on",
            "attributes": {
                "brightness": 89,
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
        self.calls.append("set_light")
        raise HomeAssistantTransportFailure("timeout")


async def test_runtime_offers_one_conclusive_probe_after_an_unknown_write() -> None:
    clock = VirtualClock()
    transport = _ProbeTransport()
    adapter = HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")
    set_request = {"brightness_pct": 35}
    brain = ScriptedFastBrain(
        [
            FastBrainOutput(
                speak=SpeakOutput(act="none"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="ha",
                        op="set_light",
                        request=set_request,
                        origin_ref="conversation:1",
                    ),
                ),
            ),
            FastBrainOutput(
                speak=SpeakOutput(act="none"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="ha",
                        op="get_state",
                        request={},
                        origin_ref="ha:1",
                    ),
                ),
            ),
        ],
        clock=clock,
        latency=0.0,
    )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(HOME_ASSISTANT_MANIFEST.policy,)),
        fastbrain=brain,
        executors={"ha": adapter},
    )
    runtime.post(UserInput("把床头灯调到 35%"))

    await runtime.run()

    assert transport.calls == ["set_light", "get_state"]
    assert [item.outcome for item in runtime.memory.channels["ha"].items] == [
        "unknown",
        "ok",
    ]
    probes = [
        affordance for affordance in brain.views[1].affordances if affordance.source == "probe"
    ]
    assert len(probes) == 1
    assert probes[0].content["op"] == "get_state"
    assert probes[0].content["unknown"]["op"] == "set_light"
    assert probes[0].conclusive is True
