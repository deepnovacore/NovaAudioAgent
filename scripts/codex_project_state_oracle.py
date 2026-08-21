"""Export/check Python v1 Codex project-state bytes consumed by the Node store.

Expected fixture content is exporter-owned.  The two byte strings differ only by live-owner crash
recovery (`starting` -> `unavailable`); their Unicode names and awkward finite timestamps make a
Node rewrite prove Python-compatible decoding *and* encoding rather than comparing parsed objects.

    uv run python scripts/codex_project_state_oracle.py check
    uv run python scripts/codex_project_state_oracle.py export
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.executors import codex_projects  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "runtime" / "codex-project-state-v1.json"


def _state(*, recovered: bool) -> codex_projects._State:
    workspace_id = "workspace-0001"
    session_id = "session-0001"
    workspace = codex_projects.WorkspaceRecord(
        workspace_id=workspace_id,
        display_name="Straße 看板",
        normalized_name="strasse 看板",
        canonical_path="/python-fixture/registered-workspace",
        origin="registered",
        codex_home_key=f"home-{workspace_id}",
        active_session_id=session_id,
        created_at=-0.0,
        last_used_at=1e-7,
    )
    session = codex_projects.ProjectSessionRecord(
        session_id=session_id,
        workspace_id=workspace_id,
        display_title="ΟΣ 修复",
        normalized_title="οσ 修复",
        codex_thread_id=None,
        state="starting",
        created_at=1e15,
        last_used_at=1e16,
    )
    if recovered:
        session = replace(session, state="unavailable")
    return codex_projects._State(
        active_workspace_id=workspace_id,
        workspaces={workspace_id: workspace},
        sessions={session_id: session},
    )


def _encode(state: codex_projects._State) -> bytes:
    return json.dumps(
        codex_projects._encode_state(state),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def build() -> dict[str, object]:
    return {
        "schema_version": 1,
        "input_utf8_base64": base64.b64encode(_encode(_state(recovered=False))).decode("ascii"),
        "recovered_utf8_base64": base64.b64encode(_encode(_state(recovered=True))).decode("ascii"),
    }


def export() -> None:
    temporary = FIXTURE.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(build(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(FIXTURE)


def check() -> int:
    if not FIXTURE.is_file():
        print(f"missing {FIXTURE.name}; run export first", file=sys.stderr)
        return 1
    committed = json.loads(FIXTURE.read_text(encoding="utf-8"))
    produced = build()
    if committed != produced:
        print(f"{FIXTURE.name} differs from the Python exporter", file=sys.stderr)
        return 1
    for key in ("input_utf8_base64", "recovered_utf8_base64"):
        decoded = json.loads(base64.b64decode(str(committed[key])))
        codex_projects._decode_state(decoded)
    print("Python Codex project-state v1 bytes match")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="check", choices=("check", "export"))
    args = parser.parse_args(argv)
    if args.command == "export":
        export()
        print(f"exported {FIXTURE.name}")
        return 0
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
