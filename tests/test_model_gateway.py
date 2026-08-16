from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.model_gateway import (
    GatewayError,
    GatewayImage,
    GatewayTextDelta,
    ModelMetrics,
    OpenAIModelGateway,
)


class _Metrics:
    def __init__(self) -> None:
        self.items: list[ModelMetrics] = []

    def record(self, metrics: ModelMetrics) -> None:
        self.items.append(metrics)


class _Create:
    def __init__(self, result=None, failure: BaseException | None = None) -> None:
        self.result = result
        self.failure = failure
        self.kwargs: dict[str, object] = {}

    async def __call__(self, **kwargs):
        self.kwargs = kwargs
        if self.failure is not None:
            raise self.failure
        return self.result


class _Client:
    def __init__(self, create: _Create) -> None:
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))


class _Stream:
    def __init__(self, chunks: list[object]) -> None:
        self.chunks = chunks

    def __aiter__(self):
        async def iterator():
            for chunk in self.chunks:
                yield chunk

        return iterator()


async def test_openai_gateway_normalizes_stream_and_records_only_metrics() -> None:
    chunk = SimpleNamespace(
        id="req-1",
        usage=SimpleNamespace(prompt_tokens=12, completion_tokens=3),
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                delta=SimpleNamespace(content="你好", tool_calls=None),
            )
        ],
    )
    create = _Create(_Stream([chunk]))
    metrics = _Metrics()
    gateway = OpenAIModelGateway(
        _Client(create),
        clock=VirtualClock(),
        metrics=metrics,
    )

    got = [
        delta
        async for delta in gateway.stream(
            model="qwen-max",
            system="secret system prompt",
            prompt="secret user prompt",
        )
    ]

    assert got == [GatewayTextDelta("你好")]
    assert metrics.items == [
        ModelMetrics(
            model="qwen-max",
            image_count=0,
            request_id="req-1",
            latency=0.0,
            input_tokens=12,
            output_tokens=3,
            finish_reason="stop",
            error_type=None,
        )
    ]
    assert "secret" not in repr(metrics.items)


async def test_openai_gateway_attaches_ordered_images_only_to_the_request() -> None:
    create = _Create(_Stream([]))
    metrics = _Metrics()
    gateway = OpenAIModelGateway(
        _Client(create),
        clock=VirtualClock(),
        metrics=metrics,
    )

    got = [
        delta
        async for delta in gateway.stream(
            model="qwen3-vl-plus",
            system="system",
            prompt="compare",
            images=(
                GatewayImage("media:a", "image/jpeg", b"a"),
                GatewayImage("media:b", "image/png", b"b"),
            ),
        )
    ]

    assert got == []
    assert create.kwargs["messages"] == [
        {"role": "system", "content": "system"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "compare"},
                {"type": "text", "text": "[media:a]"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/jpeg;base64,YQ=="},
                },
                {"type": "text", "text": "[media:b]"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,Yg=="},
                },
            ],
        },
    ]
    assert metrics.items[0].error_type is None
    assert metrics.items[0].image_count == 2
    assert "data:image" not in repr(metrics.items)


async def test_structured_completion_attaches_image_and_records_image_count() -> None:
    response = SimpleNamespace(
        id="req-watch",
        usage=None,
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content='{"hit":true,"observation":"cup"}'),
            )
        ],
    )
    create = _Create(response)
    metrics = _Metrics()
    gateway = OpenAIModelGateway(
        _Client(create),
        clock=VirtualClock(),
        metrics=metrics,
    )

    result = await gateway.complete(
        model="qwen3-vl-plus",
        system="classify",
        prompt="condition: cup",
        json_schema={"type": "object"},
        images=(GatewayImage("watch-frame", "image/jpeg", b"jpeg"),),
    )

    assert result.text == '{"hit":true,"observation":"cup"}'
    assert create.kwargs["messages"] == [
        {"role": "system", "content": "classify"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "condition: cup"},
                {"type": "text", "text": "[watch-frame]"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/jpeg;base64,anBlZw=="},
                },
            ],
        },
    ]
    assert metrics.items[0].image_count == 1


async def test_every_image_is_bound_to_its_ref_by_the_label_immediately_before_it() -> None:
    """Position alone cannot carry the binding, so each image gets a labeled neighbour.

    Emission order is candidate order (camera first, attachments newest-first, because
    that is the order the byte budget demotes in), while the prompt lists refs in view
    order. With several attachments the two are reversed relative to each other, so a
    model handed unlabeled images cannot say which ref it is describing.
    """
    create = _Create(_Stream([]))
    gateway = OpenAIModelGateway(_Client(create), clock=VirtualClock(), metrics=_Metrics())
    refs = ("media:newest", "media:middle", "media:oldest")

    async for _ in gateway.stream(
        model="qwen3-vl-plus",
        system="system",
        prompt="describe each",
        images=tuple(GatewayImage(ref, "image/png", ref.encode()) for ref in refs),
    ):
        pass

    content = create.kwargs["messages"][1]["content"]
    labels = [part["text"] for part in content if part["type"] == "text"][1:]
    assert labels == [f"[{ref}]" for ref in refs]
    for index, part in enumerate(content):
        if part["type"] == "image_url":
            assert content[index - 1] == {"type": "text", "text": f"[{refs[(index - 2) // 2]}]"}


async def test_gateway_error_does_not_echo_provider_message_or_credentials() -> None:
    fake_token = "".join(("s", "k-top-secret"))
    create = _Create(failure=RuntimeError(f"request failed for {fake_token}"))
    metrics = _Metrics()
    gateway = OpenAIModelGateway(
        _Client(create),
        clock=VirtualClock(),
        metrics=metrics,
    )

    with pytest.raises(GatewayError) as caught:
        async for _ in gateway.stream(model="qwen-max", system="system", prompt="prompt"):
            pass

    assert str(caught.value) == "模型请求失败（RuntimeError）"
    assert fake_token not in str(caught.value)
    assert metrics.items[0].error_type == "RuntimeError"


async def test_cancellation_is_not_recast_as_a_provider_failure() -> None:
    gateway = OpenAIModelGateway(
        _Client(_Create(failure=asyncio.CancelledError())),
        clock=VirtualClock(),
    )

    with pytest.raises(asyncio.CancelledError):
        async for _ in gateway.stream(model="qwen-max", system="system", prompt="prompt"):
            pass
