"""Export or check prompt-rendering goldens from the Python oracle.

Every byte a model sees is behavior. The Node port of `prompting.py` must render the
same ContextView into the same prompt, including Python's `json.dumps` separators,
its dict ordering, `str()` of list fields, and the live-progress projection.

    uv run python scripts/prompt_render_oracle.py            # check
    uv run python scripts/prompt_render_oracle.py --export    # rewrite goldens

`tests/test_prompt_render_oracle.py` runs the check. The scenarios deliberately
include a content dict whose keys are integer-like strings, because JavaScript hoists
those ahead of string keys and Python does not.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.prompting import (  # noqa: E402
    COMPRESSOR_SYSTEM,
    FASTBRAIN_LIVE_SYSTEM,
    FASTBRAIN_SYSTEM,
    SURROGATE_SYSTEM,
    render_context_snapshot,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "prompting" / "v1" / "context-views.json"
EXPECTED = FIXTURE.with_name("context-views-expected.json")


def _as_production_view(view: dict[str, Any]) -> dict[str, Any]:
    """Coerce the fields the ContextView dataclass types as ``float``.

    ``render_context_snapshot`` takes a plain mapping, so a JSON fixture written with
    ``0`` instead of ``0.0`` renders ``t=0`` while production, where the clock always
    supplies a float, renders ``t=0.0``. Coercing here keeps the fixture readable and
    still exports production semantics. Numbers inside ``content`` are deliberately
    left alone: their int-versus-float provenance is real in Python and cannot be
    represented in JavaScript, which is recorded as a divergence in the backlog.
    """
    coerced = dict(view)
    coerced["now"] = float(view["now"])
    coerced["in_flight"] = [
        {
            **entry,
            "dispatched_at": float(entry["dispatched_at"]),
            "eta": float(entry["eta"]),
            "deadline": float(entry["deadline"]),
        }
        for entry in view["in_flight"]
    ]
    coerced["channels"] = [
        {**channel, "recent": [{**item, "ts": float(item["ts"])} for item in channel["recent"]]}
        for channel in view["channels"]
    ]
    structured = dict(view["structured"])
    structured["intent"] = {
        **structured["intent"],
        "uncertainty": float(structured["intent"]["uncertainty"]),
    }
    coerced["structured"] = structured
    return coerced


def _run() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    rendered: dict[str, Any] = {}
    for scenario in document["scenarios"]:
        view = _as_production_view(scenario["view"])
        rendered[scenario["id"]] = {
            "plain": render_context_snapshot(view, include_trigger=False),
            "with_trigger": render_context_snapshot(view, include_trigger=True),
        }
    return {
        "schema_version": document["schema_version"],
        # str(float) drives every rendered timestamp and the uncertainty field.
        "float_renderings": {repr(value): str(value) for value in document["float_vectors"]},
        # .1f drives the media age, and it rounds half to even unlike toFixed.
        "fixed_one_renderings": {
            repr(value): f"{value:.1f}" for value in document["fixed_one_vectors"]
        },
        "systems": {
            "fastbrain": FASTBRAIN_SYSTEM,
            "fastbrain_live": FASTBRAIN_LIVE_SYSTEM,
            "surrogate": SURROGATE_SYSTEM,
            "compressor": COMPRESSOR_SYSTEM,
        },
        "rendered": rendered,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", action="store_true", help="rewrite the golden file")
    # Explicit argv so an embedding test runner's arguments cannot leak in.
    arguments = parser.parse_args(argv)
    produced = _run()

    if arguments.export:
        EXPECTED.write_text(
            json.dumps(produced, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"exported {len(produced['rendered'])} scenario(s) to {EXPECTED.name}")
        return 0

    if not EXPECTED.is_file():
        print(f"missing golden: {EXPECTED}", file=sys.stderr)
        return 1
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(committed) != canonical_json(produced):
        print("Python prompt rendering does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python prompt rendering parity passed: {len(produced['rendered'])} scenario(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
