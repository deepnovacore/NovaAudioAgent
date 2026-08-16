"""ContextView snapshot tool: pins down "what does FastBrain actually see".

ContextView is a pure function, so snapshots are stable — this is the most
valuable test in this round (D9). Filed starting from A2: content is still
sparse right now, but the snapshot file exists from this step onward, so the
diff at every later step becomes meaningful.

Update snapshots: NOVA_AUDIO_AGENT_UPDATE_SNAPSHOTS=1 uv run pytest
After updating you must **look at the diff** — that one glance is where all
the value of snapshot testing lives.
"""

from __future__ import annotations

import dataclasses
import json
import os
from pathlib import Path
from typing import Any

SNAPSHOT_DIR = Path(__file__).parent / "snapshots"


def to_snapshot(view: Any) -> dict[str, Any]:
    """Normalize into pure comparable data. tuples become JSON arrays, floats are kept as-is."""
    return dataclasses.asdict(view)


def assert_snapshot(name: str, payload: dict[str, Any]) -> None:
    path = SNAPSHOT_DIR / f"{name}.json"
    actual = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if os.environ.get("NOVA_AUDIO_AGENT_UPDATE_SNAPSHOTS") == "1":
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(actual, encoding="utf-8")
        return

    assert path.is_file(), f"快照缺失：{path}（用 NOVA_AUDIO_AGENT_UPDATE_SNAPSHOTS=1 生成）"
    assert actual == path.read_text(encoding="utf-8")
