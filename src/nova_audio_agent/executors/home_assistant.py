"""Single-light Home Assistant executor."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Protocol

import httpx

from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

_HTTP_TIMEOUT = 5.0
_MAX_RESPONSE_BYTES = 64 * 1024

GET_STATE = OpSpec(
    name="get_state",
    description="读取已配置灯具的当前状态",
    params={
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
    readonly=True,
    deadline_budget=8.0,
    verifies=("set_light",),
)
SET_LIGHT = OpSpec(
    name="set_light",
    description="打开、关闭或调整已配置灯具的亮度与色温",
    params={
        "type": "object",
        "properties": {
            "power": {
                "type": "string",
                "enum": ["on", "off"],
                "description": "开灯或关灯",
            },
            "brightness_pct": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "亮度百分比，1 到 100",
            },
            "color_temp_kelvin": {
                "type": "integer",
                "minimum": 1000,
                "maximum": 10000,
                "description": "色温，单位 Kelvin",
            },
        },
        "additionalProperties": False,
        "anyOf": [
            {"required": ["power"]},
            {"required": ["brightness_pct"]},
            {"required": ["color_temp_kelvin"]},
        ],
    },
    readonly=False,
    deadline_budget=8.0,
)
HOME_ASSISTANT_POLICY = HandoffPolicy(
    channel="ha",
    priority=50,
    wake="fast",
    typical_latency=1.0,
    compress_watermark=20,
)
HOME_ASSISTANT_MANIFEST = ExecutorManifest(
    name="ha",
    ops=(GET_STATE, SET_LIGHT),
    policy=HOME_ASSISTANT_POLICY,
)


class HomeAssistantClient(Protocol):
    async def get_state(self, entity_id: str) -> dict[str, Any]: ...

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]: ...


class HomeAssistantTransportFailure(RuntimeError):
    """A credential-free Home Assistant REST failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class HomeAssistantTransport:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._client = client

    async def get_state(self, entity_id: str) -> dict[str, Any]:
        response = await self._request("GET", f"/api/states/{entity_id}")
        if not isinstance(response, dict):
            raise HomeAssistantTransportFailure("malformed_response")
        return response

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if service not in {"turn_on", "turn_off"}:
            raise HomeAssistantTransportFailure("provider_rejected")
        response = await self._request(
            "POST",
            f"/api/services/light/{service}",
            service_data,
        )
        if not isinstance(response, list) or not all(isinstance(item, dict) for item in response):
            raise HomeAssistantTransportFailure("malformed_response")
        return response

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        if self._client is not None:
            return await self._request_with(
                self._client,
                method=method,
                path=path,
                payload=payload,
            )
        async with httpx.AsyncClient() as client:
            return await self._request_with(
                client,
                method=method,
                path=path,
                payload=payload,
            )

    async def _request_with(
        self,
        client: httpx.AsyncClient,
        *,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
    ) -> Any:
        request_kwargs: dict[str, Any] = {}
        if payload is not None:
            request_kwargs["json"] = payload
        try:
            async with asyncio.timeout(_HTTP_TIMEOUT):
                async with client.stream(
                    method,
                    f"{self._base_url}{path}",
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                    follow_redirects=False,
                    timeout=_HTTP_TIMEOUT,
                    **request_kwargs,
                ) as response:
                    self._check_status(response.status_code)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                            raise HomeAssistantTransportFailure("response_too_large")
                        body.extend(chunk)
        except HomeAssistantTransportFailure:
            raise
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise HomeAssistantTransportFailure("timeout") from exc
        except httpx.TransportError as exc:
            raise HomeAssistantTransportFailure("transport") from exc

        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HomeAssistantTransportFailure("malformed_response") from exc

    @staticmethod
    def _check_status(status: int) -> None:
        if 300 <= status < 400:
            raise HomeAssistantTransportFailure("redirect")
        if status in {401, 403}:
            raise HomeAssistantTransportFailure("authentication")
        if status == 404:
            raise HomeAssistantTransportFailure("not_found")
        if status == 429:
            raise HomeAssistantTransportFailure("rate_limited")
        if status >= 500:
            raise HomeAssistantTransportFailure("upstream")
        if status >= 400:
            raise HomeAssistantTransportFailure("provider_rejected")


class HomeAssistantAdapter:
    manifest = HOME_ASSISTANT_MANIFEST

    def __init__(self, transport: HomeAssistantClient, *, entity_id: str) -> None:
        self._transport = transport
        self._entity_id = entity_id

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op == "get_state":
            if request:
                return _failure("invalid_params", op)
            try:
                state = await self._transport.get_state(self._entity_id)
            except HomeAssistantTransportFailure as exc:
                return _transport_failure(exc.code, op)
            except Exception:
                return _unknown_failure("adapter_exception", op)
            return Handoff(
                outcome="ok",
                trust="trusted_system",
                content=_normalize_state(state, observed_at=ctx.clock.now()),
            )

        if op == "set_light":
            normalized = _normalize_set_light(request)
            if normalized is None:
                return _failure("invalid_params", op)
            service, service_data = normalized
            try:
                await self._transport.call_service(
                    service,
                    {"entity_id": self._entity_id, **service_data},
                )
            except HomeAssistantTransportFailure as exc:
                return _transport_failure(exc.code, op)
            except Exception:
                return _unknown_failure("adapter_exception", op)
            return Handoff(
                outcome="ok",
                trust="trusted_system",
                content={
                    "op": "set_light",
                    "entity_id": self._entity_id,
                    "service": service,
                    "request": dict(request),
                    "accepted_at": ctx.clock.now(),
                    "effect_verification": "not_performed",
                },
            )

        return _failure("unknown_op", op)


def _normalize_set_light(
    request: dict[str, Any],
) -> tuple[str, dict[str, Any]] | None:
    allowed = {"power", "brightness_pct", "color_temp_kelvin"}
    if not request or not set(request) <= allowed:
        return None

    power = request.get("power")
    brightness = request.get("brightness_pct")
    color_temp = request.get("color_temp_kelvin")
    if power is not None and power not in {"on", "off"}:
        return None
    if brightness is not None and (
        isinstance(brightness, bool)
        or not isinstance(brightness, int)
        or not 1 <= brightness <= 100
    ):
        return None
    if color_temp is not None and (
        isinstance(color_temp, bool)
        or not isinstance(color_temp, int)
        or not 1000 <= color_temp <= 10000
    ):
        return None
    if power == "off":
        if brightness is not None or color_temp is not None:
            return None
        return "turn_off", {}

    data: dict[str, Any] = {}
    if brightness is not None:
        data["brightness_pct"] = brightness
    if color_temp is not None:
        data["color_temp_kelvin"] = color_temp
    return "turn_on", data


def _normalize_state(state: dict[str, Any], *, observed_at: float) -> dict[str, Any]:
    attributes = state.get("attributes")
    if not isinstance(attributes, dict):
        attributes = {}
    brightness = attributes.get("brightness")
    brightness_pct = None
    if isinstance(brightness, int) and not isinstance(brightness, bool) and 1 <= brightness <= 255:
        brightness_pct = max(1, round(brightness * 100 / 255))
    supported_color_modes = attributes.get("supported_color_modes")
    if not isinstance(supported_color_modes, list):
        supported_color_modes = []
    return {
        "op": "get_state",
        "entity_id": state.get("entity_id"),
        "state": state.get("state"),
        "brightness_pct": brightness_pct,
        "color_temp_kelvin": attributes.get("color_temp_kelvin"),
        "min_color_temp_kelvin": attributes.get("min_color_temp_kelvin"),
        "max_color_temp_kelvin": attributes.get("max_color_temp_kelvin"),
        "supported_color_modes": supported_color_modes,
        "observed_at": observed_at,
    }


def _failure(error: str, op: str) -> Handoff:
    return Handoff(
        outcome="failed",
        trust="trusted_system",
        content={"error": error, "op": op},
    )


def _unknown_failure(error: str, op: str) -> Handoff:
    return Handoff(
        outcome="unknown",
        trust="trusted_system",
        content={"error": error, "op": op},
    )


def _transport_failure(error: str, op: str) -> Handoff:
    if error in {"authentication", "not_found", "provider_rejected"}:
        return _failure(error, op)
    return _unknown_failure(error, op)
