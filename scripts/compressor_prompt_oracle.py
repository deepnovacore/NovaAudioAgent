"""Export or check the compressor prompt the model actually receives.

`GatewayCompressor` serializes memory items straight into the prompt, so its byte
layout is model-visible: key order, float rendering, and separators all matter.

    uv run python scripts/compressor_prompt_oracle.py            # check
    uv run python scripts/compressor_prompt_oracle.py --export    # rewrite goldens
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.memory import MemoryItem  # noqa: E402
from nova_audio_agent.model_adapters import GatewayCompressor  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "adapters" / "v1" / "compressor-items.json"
EXPECTED = FIXTURE.with_name("compressor-items-expected.json")


class _RecordingGateway:
    """Captures the prompt instead of calling a provider."""

    def __init__(self) -> None:
        self.prompt: str | None = None

    async def complete(self, **kwargs: Any) -> Any:
        self.prompt = kwargs["prompt"]
        return type("_Completion", (), {"text": ""})()

    def stream(self, **kwargs: Any) -> Any:  # pragma: no cover - unused here
        raise NotImplementedError


def _item(spec: dict[str, Any]) -> MemoryItem:
    return MemoryItem(
        channel=spec["channel"],
        seq=spec["seq"],
        ts=float(spec["ts"]),
        trust=spec["trust"],
        priority=spec["priority"],
        content=spec["content"],
        outcome=spec["outcome"],
        refs=tuple(spec["refs"]),
    )


async def _run() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    prompts: dict[str, str] = {}
    for scenario in document["scenarios"]:
        gateway = _RecordingGateway()
        compressor = GatewayCompressor(gateway, model="fixture-model")
        await compressor.compress([_item(spec) for spec in scenario["items"]])
        assert gateway.prompt is not None
        prompts[scenario["id"]] = gateway.prompt
    return {"schema_version": document["schema_version"], "prompts": prompts}


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
        print(f"exported {len(produced['prompts'])} prompt(s) to {EXPECTED.name}")
        return 0

    if not EXPECTED.is_file():
        print(f"missing golden: {EXPECTED}", file=sys.stderr)
        return 1
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(committed) != canonical_json(produced):
        print("Python compressor prompt does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python compressor prompt parity passed: {len(produced['prompts'])} prompt(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
