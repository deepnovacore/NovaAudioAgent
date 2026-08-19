"""Python behavioral oracle for the desktop wire format.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/desktop_wire_oracle.py check
    uv run python scripts/desktop_wire_oracle.py export

Byte-exactness here is a requirement rather than a preference. A renderer built against one runtime has
to work against the other, and a header that differs by a separator, a field order, or an escaping rule
is a renderer that silently drops audio. So the golden records the *bytes*, hex-encoded, not a parsed
view of them -- a parsed comparison would agree on two frames no renderer would accept
interchangeably.

Rejections are recorded too, by message. What the wire refuses is as much of the contract as what it
accepts: a frame one runtime accepts and the other refuses is the same interoperability failure.
"""

from __future__ import annotations

import argparse
import difflib
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.realtime.desktop import (  # noqa: E402
    DesktopProtocolError,
    caption_message,
    codex_project_message,
    codex_state_message,
    decode_audio_frame,
    encode_audio_frame,
    playback_alert_message,
    playback_clear_message,
    playback_terminal_message,
    validate_input_pcm,
)
from nova_audio_agent.realtime.playback import PlaybackFrame  # noqa: E402
from nova_audio_agent.realtime.session import CaptionFrame  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "desktop" / "wire" / "v1" / "cases.json"
EXPECTED = FIXTURE.with_name("cases-expected.json")


class FixtureError(RuntimeError):
    """A case is malformed."""


def _pcm(spec: Any) -> bytes:
    if isinstance(spec, str):
        return bytes.fromhex(spec)
    raise FixtureError("pcm must be a hex string")


def run_case(spec: Mapping[str, Any]) -> dict[str, Any]:
    kind = spec["kind"]
    try:
        if kind == "encode_audio":
            frame = PlaybackFrame(
                utterance_id=spec["utterance_id"],
                generation_epoch=spec["generation_epoch"],
                sequence=spec["sequence"],
                pcm=_pcm(spec["pcm"]),
            )
            return {"bytes": encode_audio_frame(frame).hex()}
        if kind == "decode_audio":
            frame = decode_audio_frame(bytes.fromhex(spec["bytes"]))
            return {
                "utterance_id": frame.utterance_id,
                "generation_epoch": frame.generation_epoch,
                "sequence": frame.sequence,
                "pcm": frame.pcm.hex(),
            }
        if kind == "roundtrip_audio":
            frame = PlaybackFrame(
                utterance_id=spec["utterance_id"],
                generation_epoch=spec["generation_epoch"],
                sequence=spec["sequence"],
                pcm=_pcm(spec["pcm"]),
            )
            encoded = encode_audio_frame(frame)
            decoded = decode_audio_frame(encoded)
            return {
                "bytes": encoded.hex(),
                "utterance_id": decoded.utterance_id,
                "generation_epoch": decoded.generation_epoch,
                "sequence": decoded.sequence,
                "pcm": decoded.pcm.hex(),
            }
        if kind == "validate_input_pcm":
            return {"bytes": validate_input_pcm(_pcm(spec["pcm"])).hex()}
        if kind == "playback_clear":
            return {"text": playback_clear_message(spec["utterance_id"], spec["generation_epoch"])}
        if kind == "playback_alert":
            return {
                "text": playback_alert_message(
                    spec.get("utterance_id"), spec.get("generation_epoch")
                )
            }
        if kind == "playback_terminal":
            return {
                "text": playback_terminal_message(spec["utterance_id"], spec["generation_epoch"])
            }
        if kind == "codex_state":
            return {"text": codex_state_message(spec["state"])}
        if kind == "codex_project":
            from nova_audio_agent.realtime.desktop import PublicProjectView

            return {
                "text": codex_project_message(
                    PublicProjectView(
                        workspace_display_name=spec.get("workspace_display_name"),
                        session_title=spec.get("session_title"),
                        pending_confirmation=spec["pending_confirmation"],
                    )
                )
            }
        if kind == "caption":
            return {
                "text": caption_message(
                    CaptionFrame(role=spec["role"], text=spec["text"], final=spec["final"]),
                    spec["sequence"],
                )
            }
        raise FixtureError(f"unsupported case kind: {kind}")
    except DesktopProtocolError as error:
        return {"error": str(error)}
    except (ValueError, TypeError) as error:
        return {"error": type(error).__name__}


def run_all(document: Mapping[str, Any]) -> dict[str, Any]:
    names = [case["name"] for case in document["cases"]]
    if len(set(names)) != len(names):
        raise FixtureError("case names must be unique")
    return {
        "schema_version": 1,
        "cases": [{"name": case["name"], **run_case(case)} for case in document["cases"]],
    }


def load_document() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise FixtureError("unknown desktop wire fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(f"Python desktop wire parity passed: {len(produced['cases'])} case(s)")
        return 0
    print(_diff(committed, produced), file=sys.stderr)
    return 1


def export() -> None:
    produced = run_all(load_document())
    temporary = EXPECTED.with_suffix(".json.tmp")
    temporary.write_text(_pretty(produced) + "\n", encoding="utf-8")
    temporary.replace(EXPECTED)


def _pretty(value: Any, *, sort_keys: bool = False) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=sort_keys, allow_nan=False)


def _diff(expected: Any, actual: Any) -> str:
    return "\n".join(
        difflib.unified_diff(
            _pretty(expected, sort_keys=True).splitlines(),
            _pretty(actual, sort_keys=True).splitlines(),
            fromfile="cases-expected.json",
            tofile="python-actual.json",
            lineterm="",
        )
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            export()
            print(f"exported {EXPECTED.name}")
            return 0
        return check()
    except FixtureError as error:
        print(f"malformed fixture: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
