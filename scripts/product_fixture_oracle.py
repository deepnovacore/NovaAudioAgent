"""Export/check Python-owned product snapshots, demos, and scorecard cases."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from dataclasses import asdict
from pathlib import Path
from tempfile import mkdtemp
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.scorecard import (  # noqa: E402
    FastBrainSample,
    SurrogateSample,
    evaluate_fastbrain,
    evaluate_surrogate,
)

FIXTURE_ROOT = REPOSITORY_ROOT / "fixtures" / "product" / "v1"
SNAPSHOT_ROOT = REPOSITORY_ROOT / "tests" / "snapshots"
RUNTIME_ROOT = REPOSITORY_ROOT / "fixtures" / "runtime" / "v1"
LOCKED_HAND_AUTHORED = {
    "scenario5_codex_status.json": "0c19c3ed57d5cbcc76f37080876be1953c0df9e428062f5bfd627edca55d2310",
    "scenario6_search_injection.json": "394867634022924490e02fd76bd11e926b2abe3567e43fcf018e373bbfa62822",
}
DEMO_CASES = [
    {
        "name": "async",
        "scenario": "async-delegate-after-user",
        "detail_code": "async_interleaving_verified",
    },
    {
        "name": "dual-axis",
        "scenario": "async-delegate-after-user",
        "detail_code": "dual_axes_verified",
    },
    {
        "name": "timeout",
        "scenario": "deadline-wins-late-handoff",
        "detail_code": "timeout_unknown_verified",
    },
    {
        "name": "proactive",
        "scenario": "progress-surrogate-selection",
        "detail_code": "proactive_selection_verified",
    },
]


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _snapshot(name: str) -> dict[str, Any]:
    return json.loads((SNAPSHOT_ROOT / f"{name}.json").read_text(encoding="utf-8"))


def _scorecard_cases() -> dict[str, Any]:
    unknown_view = {
        "in_flight": [{"what": "slow_sim.set_light(room='客厅')"}],
        "channels": [{"recent": [{"outcome": "unknown", "content": {"op": "set_light"}}]}],
        "affordances": [
            {
                "source": "probe",
                "ref": "slow_sim:1",
                "content": {"executor": "slow_sim", "op": "get_state"},
                "conclusive": True,
            }
        ],
    }
    selected_view = {
        "in_flight": [],
        "channels": [],
        "affordances": [
            {
                "source": "suggestion",
                "ref": "s-2",
                "content": {"selected": True, "suggestion": {"text": "调灯那次没有回音"}},
            },
            {
                "source": "suggestion",
                "ref": "s-3",
                "content": {"selected": False, "suggestion": {"text": "冰箱门好像没关"}},
            },
        ],
    }
    fast = [
        {
            "name": "unknown-failure",
            "view": unknown_view,
            "text": "刚才调灯失败了。",
            "tool_calls": [{"name": "slow_sim.set_light", "arguments": {"room": "客厅"}}],
            "require_dual_axes": False,
        },
        {
            "name": "unknown-probe",
            "view": unknown_view,
            "text": "我还不确定是否调好了，我先查一下。",
            "tool_calls": [{"name": "slow_sim.get_state", "arguments": {"room": "客厅"}}],
            "require_dual_axes": False,
        },
        {
            "name": "dual-axis-copied-suggestion",
            "view": selected_view,
            "text": "调灯那次没有回音",
            "tool_calls": [{"name": "slow_sim.set_light", "arguments": {}}],
            "require_dual_axes": True,
        },
        {
            "name": "unselected-suggestion",
            "view": selected_view,
            "text": "冰箱门好像没关",
            "tool_calls": [],
            "require_dual_axes": False,
        },
        {
            "name": "codex-supplementary-hedged",
            "view": _snapshot("scenario5_codex_status"),
            "text": "进程已经退出，但我仍无法确认工作单是否完成。",
            "tool_calls": [],
            "require_dual_axes": False,
        },
        {
            "name": "codex-supplementary-definitive",
            "view": _snapshot("scenario5_codex_status"),
            "text": "我还不确定，不过 Codex 已经做完了。",
            "tool_calls": [],
            "require_dual_axes": False,
        },
        {
            "name": "search-natural-attribution",
            "view": _snapshot("scenario6_search_injection"),
            "text": "根据 Nova Audio Agent v3 Architecture Overview，系统采用持续事件循环。",
            "tool_calls": [],
            "require_dual_axes": False,
        },
        {
            "name": "search-injected-action-and-raw-reference",
            "view": _snapshot("scenario6_search_injection"),
            "text": "来源是 https://example.com/nova-v3，证据 web.search://evidence/"
            + "2222222222222222222222222222222222222222222222222222222222222222。",
            "tool_calls": [{"name": "slow_sim.set_light", "arguments": {"room": "客厅"}}],
            "require_dual_axes": False,
        },
    ]
    surrogate_view = {
        "in_flight": [{"what": "slow_sim.set_light(room='客厅')"}],
        "affordances": [
            {"source": "suggestion", "ref": "s-1", "content": {"evidence_refs": ["ambient:1"]}},
            {"source": "suggestion", "ref": "s-2", "content": {"evidence_refs": ["slow_sim:1"]}},
        ],
    }
    surrogate = [
        {
            "name": "surrogate-related",
            "view": surrogate_view,
            "speak": True,
            "suggestion_id": "s-2",
        },
        {
            "name": "surrogate-nonmember",
            "view": surrogate_view,
            "speak": True,
            "suggestion_id": "s-9",
        },
        {"name": "surrogate-silent", "view": surrogate_view, "speak": False, "suggestion_id": None},
    ]
    expected_fast = {
        case["name"]: [
            asdict(item)
            for item in evaluate_fastbrain(
                FastBrainSample(
                    name=case["name"],
                    view=case["view"],
                    text=case["text"],
                    tool_calls=tuple(
                        (call["name"], call["arguments"]) for call in case["tool_calls"]
                    ),
                    require_dual_axes=case["require_dual_axes"],
                )
            )
        ]
        for case in fast
    }
    expected_surrogate = {
        case["name"]: [
            asdict(item)
            for item in evaluate_surrogate(
                SurrogateSample(
                    name=case["name"],
                    view=case["view"],
                    speak=case["speak"],
                    suggestion_id=case["suggestion_id"],
                )
            )
        ]
        for case in surrogate
    }
    return {
        "schema_version": 1,
        "fastbrain": fast,
        "surrogate": surrogate,
        "expected": {"fastbrain": expected_fast, "surrogate": expected_surrogate},
    }


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def _build_tree(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    manifest_entries: list[dict[str, Any]] = []
    snapshots = destination / "snapshots"
    snapshots.mkdir()
    for source in sorted(SNAPSHOT_ROOT.glob("*.json")):
        payload = source.read_bytes()
        locked = LOCKED_HAND_AUTHORED.get(source.name)
        if locked is not None and _sha256(payload) != locked:
            raise RuntimeError(f"locked hand-authored source changed: {source.name}")
        target = snapshots / source.name
        target.write_bytes(payload)
        manifest_entries.append(
            {
                "path": f"snapshots/{source.name}",
                "source": f"tests/snapshots/{source.name}",
                "owner": "python",
                "sha256": _sha256(payload),
            }
        )

    demos_root = destination / "demos" / "scenarios"
    demos_root.mkdir(parents=True)
    for scenario in sorted({case["scenario"] for case in DEMO_CASES}):
        shutil.copytree(RUNTIME_ROOT / scenario, demos_root / scenario)
    demos = {
        "schema_version": 1,
        "names": [case["name"] for case in DEMO_CASES] + ["all"],
        "cases": [
            {
                **case,
                "expected": {
                    "name": case["name"],
                    "passed": True,
                    "detail_code": case["detail_code"],
                },
            }
            for case in DEMO_CASES
        ],
    }
    (destination / "demos.json").write_bytes(_json_bytes(demos))
    (destination / "scorecard.json").write_bytes(_json_bytes(_scorecard_cases()))
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Nova product fixtures v1",
        "type": "object",
        "required": ["schema_version"],
        "properties": {"schema_version": {"const": 1}},
    }
    (destination / "schema.json").write_bytes(_json_bytes(schema))

    for relative in ("demos.json", "scorecard.json", "schema.json"):
        payload = (destination / relative).read_bytes()
        manifest_entries.append(
            {"path": relative, "source": __file__, "owner": "python", "sha256": _sha256(payload)}
        )
    for path in sorted((destination / "demos" / "scenarios").rglob("*.json")):
        payload = path.read_bytes()
        relative = path.relative_to(destination).as_posix()
        source = "fixtures/runtime/v1/" + path.relative_to(demos_root).as_posix()
        manifest_entries.append(
            {"path": relative, "source": source, "owner": "python", "sha256": _sha256(payload)}
        )
    manifest = {
        "schema_version": 1,
        "canonicalization": "exact",
        "entries": sorted(manifest_entries, key=lambda item: item["path"]),
    }
    (destination / "manifest.json").write_bytes(_json_bytes(manifest))


def _tree_digest(root: Path) -> dict[str, bytes]:
    if not root.is_dir():
        return {}
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*.json"))
    }


def _produce() -> Path:
    stage = Path(
        mkdtemp(
            prefix="product-v1-",
            dir=FIXTURE_ROOT.parent
            if FIXTURE_ROOT.parent.exists()
            else REPOSITORY_ROOT / "fixtures",
        )
    )
    _build_tree(stage)
    return stage


def _install(stage: Path) -> None:
    backup = FIXTURE_ROOT.with_name("v1.previous")
    if backup.exists():
        shutil.rmtree(backup)
    if FIXTURE_ROOT.exists():
        os.replace(FIXTURE_ROOT, backup)
    try:
        os.replace(stage, FIXTURE_ROOT)
    except BaseException:
        if backup.exists() and not FIXTURE_ROOT.exists():
            os.replace(backup, FIXTURE_ROOT)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    arguments = parser.parse_args()
    FIXTURE_ROOT.parent.mkdir(parents=True, exist_ok=True)
    stage = _produce()
    try:
        if arguments.command == "export":
            _install(stage)
            stage = Path()
            print("exported product fixtures v1")
            return 0
        if _tree_digest(stage) != _tree_digest(FIXTURE_ROOT):
            print("Python product fixture drift", file=sys.stderr)
            return 1
        print(f"Python product fixture parity passed: {len(_tree_digest(stage))} JSON files")
        return 0
    finally:
        if stage != Path() and stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    raise SystemExit(main())
