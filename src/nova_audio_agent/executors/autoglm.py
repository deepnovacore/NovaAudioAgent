"""Bounded AutoGLM iPhone adapter and loopback WebDriverAgent client."""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import warnings
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from PIL import Image

from nova_audio_agent.executors.autoglm_protocol import AutoGlmWorkerResult, sanitize_worker_events
from nova_audio_agent.executors.autoglm_transport import (
    AutoGlmRunDeadline,
    AutoGlmTransportFailure,
)
from nova_audio_agent.media import MediaStore
from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

_WDA_TIMEOUT = 5.0
_MAX_WDA_RESPONSE_BYTES = 16 * 1024 * 1024
_MAX_SCREENSHOT_PIXELS = 16_777_216
_ALLOWED_BUNDLE_IDS = frozenset({"com.apple.mobilesafari", "com.apple.springboard"})

BROWSE = OpSpec(
    name="browse",
    description="仅在 iPhone Safari 中搜索一个简短查询",
    params={
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
    },
    readonly=False,
    deadline_budget=180.0,
    sensitive_params=("query",),
)

SCREENSHOT = OpSpec(
    name="screenshot",
    description="捕获当前 iPhone 屏幕，返回图片引用",
    params={
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    },
    readonly=True,
    deadline_budget=7.0,
    verifies=(),
)

AUTOGLM_POLICY = HandoffPolicy(
    channel="autoglm",
    priority=50,
    wake="fast",
    typical_latency=30.0,
    compress_watermark=20,
)

AUTOGLM_MANIFEST = ExecutorManifest(
    name="autoglm",
    ops=(BROWSE, SCREENSHOT),
    policy=AUTOGLM_POLICY,
)


@dataclass(frozen=True, slots=True)
class WdaScreenshot:
    payload: bytes
    media_type: str
    width: int
    height: int


class WdaFailure(RuntimeError):
    """A credential- and pixel-free WDA failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class AutoGlmWorker(Protocol):
    async def run_browse(
        self,
        query: str,
        *,
        deadline: AutoGlmRunDeadline,
    ) -> AutoGlmWorkerResult: ...


class WdaClient(Protocol):
    async def active_bundle_id(self) -> str: ...

    async def screenshot(self) -> WdaScreenshot: ...


class AutoGlmWdaClient:
    """Read only the active app and PNG screenshot from a fixed loopback WDA."""

    def __init__(self, base_url: str, *, client: httpx.AsyncClient | None = None) -> None:
        self._base_url = _validate_wda_url(base_url)
        self._client = client

    async def active_bundle_id(self) -> str:
        body = await self._request("/wda/activeAppInfo")
        value = _json_value(body)
        if not isinstance(value, dict):
            raise WdaFailure("malformed_response")
        bundle_id = value.get("bundleId")
        if not _valid_bundle_id(bundle_id):
            raise WdaFailure("malformed_response")
        return bundle_id

    async def screenshot(self) -> WdaScreenshot:
        body = await self._request("/screenshot")
        encoded = _json_value(body)
        if type(encoded) is not str:
            raise WdaFailure("malformed_response")
        try:
            payload = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise WdaFailure("malformed_response") from None
        width, height = _png_dimensions(payload)
        return WdaScreenshot(
            payload=payload,
            media_type="image/png",
            width=width,
            height=height,
        )

    async def _request(self, path: str) -> bytes:
        if self._client is not None:
            return await self._request_with(self._client, path)
        async with httpx.AsyncClient(trust_env=False) as client:
            return await self._request_with(client, path)

    async def _request_with(self, client: httpx.AsyncClient, path: str) -> bytes:
        try:
            async with asyncio.timeout(_WDA_TIMEOUT):
                async with client.stream(
                    "GET",
                    f"{self._base_url}{path}",
                    follow_redirects=False,
                    timeout=_WDA_TIMEOUT,
                ) as response:
                    if response.status_code != 200:
                        raise WdaFailure("http_failure")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > _MAX_WDA_RESPONSE_BYTES:
                            raise WdaFailure("response_too_large")
                        body.extend(chunk)
        except WdaFailure:
            raise
        except (TimeoutError, httpx.TimeoutException):
            raise WdaFailure("timeout") from None
        except httpx.TransportError:
            raise WdaFailure("transport") from None
        return bytes(body)


class AutoGlmAdapter:
    manifest = AUTOGLM_MANIFEST

    def __init__(self, worker: AutoGlmWorker, wda: WdaClient, store: MediaStore) -> None:
        self._worker = worker
        self._wda = wda
        self._store = store

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op == "browse":
            query = _normalize_browse(request)
            if query is None:
                return _failure("failed", "invalid_params", op)
            return await self._browse(query, ctx)
        if op == "screenshot":
            if request:
                return _failure("failed", "invalid_params", op)
            return await self._screenshot(ctx)
        return _failure("failed", "unknown_op", op)

    async def _browse(self, query: str, ctx: DispatchContext) -> Handoff:
        try:
            bundle_id = await self._wda.active_bundle_id()
        except Exception:
            return _failure("failed", "wda_unavailable", "browse")
        if not _valid_bundle_id(bundle_id):
            return _failure("failed", "wda_unavailable", "browse")
        if bundle_id not in _ALLOWED_BUNDLE_IDS:
            return _failure("failed", "current_app_not_allowed", "browse")

        try:
            result = await self._worker.run_browse(
                query,
                deadline=AutoGlmRunDeadline(
                    expires_at=ctx.delegate.deadline,
                    clock=ctx.clock,
                ),
            )
        except AutoGlmTransportFailure as exc:
            if not exc.worker_started:
                return _failure("failed", exc.code, "browse")
            return _failure(
                "unknown",
                exc.code,
                "browse",
                effect_verification="not_performed",
            )
        except Exception:
            return _failure(
                "unknown",
                "adapter_exception",
                "browse",
                effect_verification="not_performed",
            )

        try:
            if not isinstance(result, AutoGlmWorkerResult):
                raise TypeError("invalid worker result")
            content: dict[str, Any] = {
                "op": "browse",
                "code" if result.outcome == "completed" else "error": result.code,
                "effect_verification": result.effect_verification,
                "events": [dict(event) for event in sanitize_worker_events(result.events)],
            }
            outcome = {"completed": "ok", "blocked": "failed", "failed": "unknown"}[result.outcome]
        except Exception:
            return _failure(
                "unknown",
                "adapter_exception",
                "browse",
                effect_verification="not_performed",
            )
        return Handoff(outcome=outcome, trust="untrusted_external", content=content)

    async def _screenshot(self, ctx: DispatchContext) -> Handoff:
        try:
            frame = await self._wda.screenshot()
        except Exception:
            return _failure("failed", "wda_unavailable", "screenshot")
        if not isinstance(frame, WdaScreenshot):
            return _failure("failed", "wda_unavailable", "screenshot")
        try:
            entry = self._store.put(
                frame.payload,
                media_type=frame.media_type,
                width=frame.width,
                height=frame.height,
                captured_at=ctx.clock.now(),
            )
        except ValueError:
            return _failure("failed", "media_store_rejected", "screenshot")
        except Exception:
            return _failure("unknown", "adapter_exception", "screenshot")
        return Handoff(
            outcome="ok",
            trust="untrusted_external",
            content={
                "op": "screenshot",
                "media_ref": entry.ref,
                "digest": entry.digest,
                "media_type": entry.media_type,
                "width": entry.width,
                "height": entry.height,
                "captured_at": entry.captured_at,
            },
            refs=(entry.ref,),
        )


def _normalize_browse(request: dict[str, Any]) -> str | None:
    if set(request) != {"query"}:
        return None
    query = request.get("query")
    if type(query) is not str:
        return None
    query = query.strip()
    if not query or len(query) > 200:
        return None
    return query


def _valid_bundle_id(value: object) -> bool:
    return (
        type(value) is str
        and 0 < len(value) <= 256
        and all(character.isprintable() and not character.isspace() for character in value)
    )


def _failure(
    outcome: str,
    code: str,
    op: str,
    **content: Any,
) -> Handoff:
    return Handoff(
        outcome=outcome,  # type: ignore[arg-type]
        trust="untrusted_external",
        content={"error": code, "op": op, **content},
    )


def _validate_wda_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ValueError("invalid_wda_url") from None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port != 8100
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_wda_url")
    return f"http://{parsed.hostname}:8100"


def _json_value(body: bytes) -> Any:
    try:
        document = json.loads(body, parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise WdaFailure("malformed_response") from None
    if (
        not isinstance(document, dict)
        or "value" not in document
        or not set(document) <= {"value", "sessionId"}
    ):
        raise WdaFailure("malformed_response")
    return document["value"]


def _png_dimensions(payload: bytes) -> tuple[int, int]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as image:
                image_format = image.format
                width, height = image.size
                image.verify()
    except Exception:
        raise WdaFailure("malformed_response")
    if (
        image_format != "PNG"
        or width <= 0
        or height <= 0
        or width * height > _MAX_SCREENSHOT_PIXELS
    ):
        raise WdaFailure("malformed_response")
    return width, height


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-standard JSON constant")
