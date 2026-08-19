"""Export or check compiled tool-schema goldens from the Python oracle.

Tool names, descriptions, and parameter schemas are all model-visible, and the
wire-name mangling plus the injected ``origin_ref`` are contract behavior. The Node
port must emit byte-identical schemas and the same binding table.

    uv run python scripts/tool_schema_oracle.py            # check
    uv run python scripts/tool_schema_oracle.py --export    # rewrite goldens

`tests/test_tool_schema_oracle.py` runs the check.
"""

from __future__ import annotations

import argparse
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
from nova_audio_agent.memory import HandoffPolicy  # noqa: E402
from nova_audio_agent.ports import ExecutorManifest, OpSpec  # noqa: E402
from nova_audio_agent.tool_schema import compile_tool_schema  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "tools" / "v1" / "manifests.json"
EXPECTED = FIXTURE.with_name("manifests-expected.json")


#: OpSpec fields the dataclass requires as tuples; JSON gives lists.
_TUPLE_FIELDS = ("sensitive_params",)


def _manifest(spec: dict[str, Any]) -> ExecutorManifest:
    policy = HandoffPolicy(**spec["policy"])
    ops = tuple(
        OpSpec(
            **{key: tuple(value) if key in _TUPLE_FIELDS else value for key, value in op.items()}
        )
        for op in spec["ops"]
    )
    return ExecutorManifest(name=spec["name"], policy=policy, ops=ops)


def _run() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    results: dict[str, Any] = {}
    for scenario in document["scenarios"]:
        compiled = compile_tool_schema(
            [_manifest(spec) for spec in scenario["manifests"]],
            include_memory_recall=scenario["include_memory_recall"],
        )
        results[scenario["id"]] = {
            "schemas": list(compiled.schemas),
            "bindings": {
                name: dataclasses.asdict(binding) for name, binding in compiled.bindings.items()
            },
            "binding_order": list(compiled.bindings),
        }
    return {"schema_version": document["schema_version"], "scenarios": results}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", action="store_true", help="rewrite the golden file")
    arguments = parser.parse_args(argv)
    produced = _run()

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
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(committed) != canonical_json(produced):
        print("Python tool schema does not match the committed golden", file=sys.stderr)
        return 1
    print(f"Python tool schema parity passed: {len(produced['scenarios'])} scenario(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
