"""Export or check Qwen frame-normalization goldens from the Python adapter.

The Node port of `realtime/qwen.py` must turn identical provider frames into
identical neutral events. This drives the real `QwenAudioRealtimeAdapter` through
its public `connect`/`events` path over a scripted socket, so the exported golden
covers the receiver loop and its termination rules, not just the pure normalizer.

    uv run python scripts/qwen_normalization_oracle.py           # check
    uv run python scripts/qwen_normalization_oracle.py --export   # rewrite goldens

Normal runs are read-only. `tests/test_qwen_normalization_oracle.py` runs the check.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.realtime.qwen import QwenAudioRealtimeAdapter  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "qwen" / "v1" / "normalization.json"
EXPECTED = FIXTURE.with_name("normalization-expected.json")

#: Neutral event kind for each provider-event dataclass, matching the Zod
#: discriminator the Node contract uses.
_EVENT_KINDS = {
    "UserSpeechStarted": "user_speech_started",
    "UserSpeechEnded": "user_speech_ended",
    "UserTranscriptDelta": "user_transcript_delta",
    "UserTranscriptFailed": "user_transcript_failed",
    "UserTranscriptFinal": "user_transcript_final",
    "ResponseStarted": "response_started",
    "ResponseAudioDelta": "response_audio_delta",
    "ResponseTranscriptDelta": "response_transcript_delta",
    "ResponseTranscriptFinal": "response_transcript_final",
    "ToolCallReady": "tool_call_ready",
    "ResponseTerminal": "response_terminal",
    "ResponseCancelRejected": "response_cancel_rejected",
    "ProviderErrorEvent": "provider_error",
}


class ScriptedSocket:
    """Yields scripted frames, then reports EOF the way the real transport closes."""

    def __init__(self, frames: list[dict[str, Any]]) -> None:
        self._frames = list(frames)
        self.sent: list[dict[str, Any]] = []
        self.closed = False

    async def recv(self) -> str:
        if not self._frames:
            raise EOFError
        return json.dumps(self._frames.pop(0), ensure_ascii=False)

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    async def close(self) -> None:
        self.closed = True


def _serialize(event: Any) -> dict[str, Any]:
    record = dataclasses.asdict(event)
    record["kind"] = _EVENT_KINDS[type(event).__name__]
    if "pcm" in record:
        record["pcm"] = list(record["pcm"])
    return record


def _identity_factory() -> Any:
    counter = {"value": 0}

    def next_id() -> str:
        counter["value"] += 1
        return f"id-{counter['value']}"

    return next_id


async def _replay_handshake(handshake: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Capture the frames the adapter sends while connecting.

    The session.update payload carries the model-visible session instructions. A
    hand-copied port of that text silently dropped most of it once, and no test
    noticed because the Node assertion compared the constant to itself. Exporting
    the whole outbound payload from Python makes drift a failure.
    """
    socket = ScriptedSocket(list(handshake))

    async def connector(_endpoint: str, **_kwargs: Any) -> ScriptedSocket:
        return socket

    adapter = QwenAudioRealtimeAdapter(
        url="wss://example.invalid/realtime",
        api_key="fixture-key",
        model="fixture-model",
        voice="fixture-voice",
        connector=connector,
        id_factory=_identity_factory(),
    )
    await adapter.connect(tools=())
    await adapter.close()
    return socket.sent


async def _replay(handshake: list[dict[str, Any]], frames: list[dict[str, Any]]) -> list[Any]:
    socket = ScriptedSocket([*handshake, *frames])

    async def connector(_endpoint: str, **_kwargs: Any) -> ScriptedSocket:
        return socket

    adapter = QwenAudioRealtimeAdapter(
        url="wss://example.invalid/realtime",
        api_key="fixture-key",
        model="fixture-model",
        voice="fixture-voice",
        connector=connector,
        id_factory=_identity_factory(),
    )
    await adapter.connect(tools=())
    observed: list[Any] = []
    async for event in adapter.events():
        observed.append(_serialize(event))
    await adapter.close()
    return observed


async def _run() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    handshake = document["handshake"]
    results: dict[str, Any] = {
        "schema_version": document["schema_version"],
        "outbound_handshake": await _replay_handshake(handshake),
        "scenarios": {},
    }
    for scenario in document["scenarios"]:
        results["scenarios"][scenario["id"]] = await _replay(handshake, scenario["frames"])
    return results


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--export",
        action="store_true",
        help="rewrite the golden file instead of checking it",
    )
    # Take an explicit argv so an embedding test runner's own arguments cannot leak in.
    arguments = parser.parse_args(argv)
    produced = asyncio.run(_run())
    rendered = canonical_json(produced)

    if arguments.export:
        EXPECTED.write_text(
            json.dumps(produced, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"exported {len(produced['scenarios'])} scenario(s) to {EXPECTED.name}")
        return 0

    if not EXPECTED.is_file():
        print(f"missing golden: {EXPECTED}", file=sys.stderr)
        return 1
    committed = canonical_json(json.loads(EXPECTED.read_text(encoding="utf-8")))
    if committed != rendered:
        print("Python Qwen normalization does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python Qwen normalization parity passed: {len(produced['scenarios'])} scenario(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
