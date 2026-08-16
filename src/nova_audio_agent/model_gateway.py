"""Provider-neutral model gateway plus the OpenAI-compatible implementation."""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from nova_audio_agent.clock import Clock

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class GatewayTextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class GatewayToolCallDelta:
    index: int
    name: str = ""
    arguments: str = ""


GatewayDelta = GatewayTextDelta | GatewayToolCallDelta


@dataclass(frozen=True, slots=True)
class GatewayCompletion:
    text: str


@dataclass(frozen=True, slots=True)
class GatewayImage:
    ref: str
    media_type: str
    payload: bytes


def _image_parts(images: Sequence[GatewayImage]) -> list[dict[str, Any]]:
    """Bind each image to its ref with a label part immediately before it.

    Position alone cannot carry the binding. Images are emitted in candidate order
    (camera first, then attachments newest-first, because that is the order the byte
    budget demotes in), while the prompt lists refs in view order — the two disagree,
    and with several attachments they are reversed relative to each other. A model
    handed N unlabeled images then has no way to say which ref it is describing, which
    breaks exactly the "compare these three photos" case the two-bound design exists to
    support.

    Labeling makes the binding explicit at the provider protocol level, so emission
    order stops carrying meaning and stays free to follow the budget.
    """
    parts: list[dict[str, Any]] = []
    for image in images:
        encoded = base64.b64encode(image.payload).decode("ascii")
        parts.append({"type": "text", "text": f"[{image.ref}]"})
        parts.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{image.media_type};base64,{encoded}"},
            }
        )
    return parts


@dataclass(frozen=True, slots=True)
class ModelMetrics:
    model: str
    image_count: int
    request_id: str | None
    latency: float
    input_tokens: int | None
    output_tokens: int | None
    finish_reason: str | None
    error_type: str | None


class MetricsSink(Protocol):
    def record(self, metrics: ModelMetrics) -> None: ...


class _LoggingMetrics:
    def record(self, metrics: ModelMetrics) -> None:
        logger.info(
            "model_call model=%s images=%s request_id=%s latency=%.3f input_tokens=%s "
            "output_tokens=%s finish_reason=%s error_type=%s",
            metrics.model,
            metrics.image_count,
            metrics.request_id,
            metrics.latency,
            metrics.input_tokens,
            metrics.output_tokens,
            metrics.finish_reason,
            metrics.error_type,
        )


class ModelGateway(Protocol):
    def stream(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        tools: Sequence[dict[str, Any]] = (),
        images: Sequence[GatewayImage] = (),
    ) -> AsyncIterator[GatewayDelta]: ...

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, Any] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion: ...


class GatewayError(RuntimeError):
    """A provider failure whose message contains only the exception type."""


class OpenAIModelGateway:
    """OpenAI-compatible transport. Prompts and outputs never enter metrics or logs."""

    def __init__(
        self,
        client: Any,
        *,
        clock: Clock,
        metrics: MetricsSink | None = None,
    ) -> None:
        self._client = client
        self._clock = clock
        self._metrics = metrics or _LoggingMetrics()

    async def stream(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        tools: Sequence[dict[str, Any]] = (),
        images: Sequence[GatewayImage] = (),
    ) -> AsyncIterator[GatewayDelta]:
        started = self._clock.now()
        request_id: str | None = None
        input_tokens: int | None = None
        output_tokens: int | None = None
        finish_reason: str | None = None
        error_type: str | None = None
        user_content: object = prompt
        if images:
            user_content = [{"type": "text", "text": prompt}, *_image_parts(images)]
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            kwargs["tools"] = list(tools)
            kwargs["parallel_tool_calls"] = False
        try:
            stream = await self._client.chat.completions.create(**kwargs)
            async for chunk in stream:
                request_id = getattr(chunk, "id", None) or request_id
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    input_tokens = getattr(usage, "prompt_tokens", None)
                    output_tokens = getattr(usage, "completion_tokens", None)
                for choice in getattr(chunk, "choices", ()) or ():
                    finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                    delta = choice.delta
                    text = getattr(delta, "content", None)
                    if text:
                        yield GatewayTextDelta(text=text)
                    for tool in getattr(delta, "tool_calls", None) or ():
                        function = tool.function
                        yield GatewayToolCallDelta(
                            index=tool.index,
                            name=getattr(function, "name", None) or "",
                            arguments=getattr(function, "arguments", None) or "",
                        )
        except Exception as exc:
            error_type = type(exc).__name__
            raise GatewayError(f"模型请求失败（{error_type}）") from exc
        finally:
            self._record_metrics(
                model=model,
                image_count=len(images),
                started=started,
                request_id=request_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                finish_reason=finish_reason,
                error_type=error_type,
            )

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, Any] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion:
        started = self._clock.now()
        request_id: str | None = None
        input_tokens: int | None = None
        output_tokens: int | None = None
        finish_reason: str | None = None
        error_type: str | None = None
        user_content: object = prompt
        if images:
            user_content = [{"type": "text", "text": prompt}, *_image_parts(images)]
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
        }
        if json_schema is not None:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            response = await self._client.chat.completions.create(**kwargs)
            request_id = getattr(response, "id", None)
            usage = getattr(response, "usage", None)
            if usage is not None:
                input_tokens = getattr(usage, "prompt_tokens", None)
                output_tokens = getattr(usage, "completion_tokens", None)
            choice = response.choices[0]
            finish_reason = getattr(choice, "finish_reason", None)
            return GatewayCompletion(text=choice.message.content or "")
        except Exception as exc:
            error_type = type(exc).__name__
            raise GatewayError(f"模型请求失败（{error_type}）") from exc
        finally:
            self._record_metrics(
                model=model,
                image_count=len(images),
                started=started,
                request_id=request_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                finish_reason=finish_reason,
                error_type=error_type,
            )

    def _record_metrics(
        self,
        *,
        model: str,
        image_count: int,
        started: float,
        request_id: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        finish_reason: str | None,
        error_type: str | None,
    ) -> None:
        self._metrics.record(
            ModelMetrics(
                model=model,
                image_count=image_count,
                request_id=request_id,
                latency=self._clock.now() - started,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                finish_reason=finish_reason,
                error_type=error_type,
            )
        )
