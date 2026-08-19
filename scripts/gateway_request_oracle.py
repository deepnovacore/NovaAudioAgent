"""Export or check the model-gateway request bodies the provider actually receives.

`OpenAIModelGateway` builds its payload through the `openai` SDK in Python and through
`fetch` in Node. The client library is not the contract; the wire body is, and it is
model-visible. This captures it by handing the gateway a recording double in place of
the SDK client.

    uv run python scripts/gateway_request_oracle.py            # check
    uv run python scripts/gateway_request_oracle.py --export    # rewrite goldens

`tests/test_gateway_request_oracle.py` runs the check.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.clock import VirtualClock  # noqa: E402
from nova_audio_agent.model_gateway import (  # noqa: E402
    GatewayImage,
    OpenAIModelGateway,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "gateway" / "v1" / "requests.json"
EXPECTED = FIXTURE.with_name("requests-expected.json")


class _RecordingCompletions:
    def __init__(self, recorder: list[dict[str, Any]], streaming: bool) -> None:
        self._recorder = recorder
        self._streaming = streaming

    async def create(self, **kwargs: Any) -> Any:
        self._recorder.append(kwargs)
        if self._streaming:
            return _EmptyStream()
        return _EmptyCompletion()


class _EmptyStream:
    def __aiter__(self) -> Any:
        return self

    async def __anext__(self) -> Any:
        raise StopAsyncIteration


class _Message:
    content = ""


class _Choice:
    finish_reason = "stop"
    message = _Message()


class _EmptyCompletion:
    id = "req-fixture"
    usage = None
    choices = (_Choice(),)


class _RecordingClient:
    def __init__(self, recorder: list[dict[str, Any]], streaming: bool) -> None:
        self.chat = type("_Chat", (), {"completions": _RecordingCompletions(recorder, streaming)})()


class _NullMetrics:
    def record(self, metrics: Any) -> None:  # noqa: ANN401 - protocol shape
        del metrics


def _images(specs: Sequence[dict[str, Any]]) -> tuple[GatewayImage, ...]:
    return tuple(
        GatewayImage(
            ref=spec["ref"],
            media_type=spec["media_type"],
            payload=base64.b64decode(spec["payload_base64"], validate=True),
        )
        for spec in specs
    )


async def _capture(scenario: dict[str, Any]) -> dict[str, Any]:
    recorder: list[dict[str, Any]] = []
    streaming = scenario["mode"] == "stream"
    gateway = OpenAIModelGateway(
        _RecordingClient(recorder, streaming),
        clock=VirtualClock(),
        metrics=_NullMetrics(),
    )
    images = _images(scenario.get("images", ()))
    if streaming:
        async for _delta in gateway.stream(
            model=scenario["model"],
            system=scenario["system"],
            prompt=scenario["prompt"],
            tools=tuple(scenario.get("tools", ())),
            images=images,
        ):
            pass
    else:
        await gateway.complete(
            model=scenario["model"],
            system=scenario["system"],
            prompt=scenario["prompt"],
            json_schema=scenario.get("json_schema"),
            images=images,
        )
    assert len(recorder) == 1, "each scenario must issue exactly one provider request"
    return recorder[0]


async def _run() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    bodies = {scenario["id"]: await _capture(scenario) for scenario in document["scenarios"]}
    return {"schema_version": document["schema_version"], "requests": bodies}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", action="store_true", help="rewrite the golden file")
    arguments = parser.parse_args(argv)
    produced = asyncio.run(_run())

    if arguments.export:
        EXPECTED.write_text(
            json.dumps(produced, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"exported {len(produced['requests'])} request(s) to {EXPECTED.name}")
        return 0

    if not EXPECTED.is_file():
        print(f"missing golden: {EXPECTED}", file=sys.stderr)
        return 1
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(committed) != canonical_json(produced):
        print("Python gateway request body does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python gateway request parity passed: {len(produced['requests'])} request(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
