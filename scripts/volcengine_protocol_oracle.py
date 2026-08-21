"""Export/check Volcengine pure config and protocol goldens from Python production code."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import struct
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any
from unittest.mock import patch

from pydantic import SecretStr, ValidationError

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.config import ConfigurationError, Settings  # noqa: E402
from nova_audio_agent.realtime.volcengine.asr import (  # noqa: E402
    DoubaoAsrError,
    DoubaoAsrProtocol,
)
from nova_audio_agent.realtime.volcengine.protocol import (  # noqa: E402
    EventType,
    MessageType,
    VolcMessage,
    VolcProtocolError,
)
from nova_audio_agent.realtime.volcengine.tts import TextChunker  # noqa: E402

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "volcengine" / "v1" / "protocol.json"
EXPECTED = FIXTURE.with_name("protocol-expected.json")

_KEY_VALUES = {
    "ark": "fixture-ark-key",
    "asr_dedicated": "fixture-asr-key",
    "tts_fallback": "fixture-tts-key",
}
_KEY_LABELS = {value: label for label, value in _KEY_VALUES.items()}
_SECRET_FIELDS = {"ark_api_key", "doubao_asr_api_key", "doubao_bigmodel_api_key"}


def _safe_error(error: BaseException) -> dict[str, str]:
    return {"error": type(error).__name__, "message": str(error)}


def _settings(raw: Mapping[str, Any]) -> Settings:
    values = dict(raw)
    for name in _SECRET_FIELDS & values.keys():
        label = values[name]
        if isinstance(label, str):
            stripped = label.strip("\x1c\x1d\x1e\x1f\x85 \t\n\r\v\f")
            mapped = _KEY_VALUES.get(stripped)
            if mapped is not None:
                prefix = label[: len(label) - len(label.lstrip("\x1c\x1d\x1e\x1f\x85 \t\n\r\v\f"))]
                suffix = label[len(label.rstrip("\x1c\x1d\x1e\x1f\x85 \t\n\r\v\f")) :]
                values[name] = SecretStr(prefix + mapped + suffix)
            else:
                values[name] = SecretStr(label)
    return Settings(_env_file=None, **values)


def _config_case(case: Mapping[str, Any]) -> dict[str, Any]:
    try:
        settings = _settings(case["settings"])
        if case["action"] == "load":
            return {"ok": True}
        resolved = asdict(settings.require_volcengine_realtime())
        for field in ("ark_api_key", "asr_api_key", "tts_api_key"):
            resolved[field] = _KEY_LABELS[resolved[field]]
        return {"ok": True, "config": resolved}
    except (ConfigurationError, ValidationError) as error:
        if isinstance(error, ValidationError):
            fields = sorted({str(item["loc"][0]).upper() for item in error.errors()})
            return {"ok": False, "error": "ValidationError", "fields": fields}
        return {"ok": False, **_safe_error(error)}


def _asr_encode(case: Mapping[str, Any]) -> dict[str, Any]:
    protocol = DoubaoAsrProtocol()
    with patch("nova_audio_agent.realtime.volcengine.asr.uuid4", return_value="fixture-user-id"):
        if case["kind"] == "full":
            wire = protocol.full_request(sequence=case["sequence"], sample_rate=case["sample_rate"])
        else:
            wire = protocol.audio(
                sequence=case["sequence"],
                pcm=base64.b64decode(case["pcm_b64"]),
                final=case["final"],
            )
    payload_size = struct.unpack(">I", wire[8:12])[0]
    payload = gzip.decompress(wire[12 : 12 + payload_size])
    return {
        "header": list(wire[:4]),
        "sequence": struct.unpack(">i", wire[4:8])[0],
        "payload_size_matches": payload_size == len(wire) - 12,
        "payload": json.loads(payload)
        if case["kind"] == "full"
        else base64.b64encode(payload).decode(),
    }


def _asr_server_frame(case: Mapping[str, Any]) -> bytes:
    payload = json.dumps(case["body"], ensure_ascii=False, separators=(",", ":")).encode()
    if case["compressed"]:
        payload = gzip.compress(payload, mtime=0)
    compression = 1 if case["compressed"] else 0
    wire = (
        bytes((0x11, 0x90 | case["flags"], 0x10 | compression, 0))
        + struct.pack(">iI", case["sequence"], len(payload))
        + payload
    )
    return wire + base64.b64decode(case.get("trailing_b64", ""))


def _asr_decode(case: Mapping[str, Any]) -> dict[str, Any]:
    frame = _asr_server_frame(case)
    try:
        transcript = DoubaoAsrProtocol().decode(frame)
        result: Any = None if transcript is None else asdict(transcript)
    except DoubaoAsrError as error:
        result = _safe_error(error)
    return {"frame_b64": base64.b64encode(frame).decode(), "result": result}


def _tts_wire(case: Mapping[str, Any]) -> bytes:
    if case["action"] == "marshal-roundtrip":
        return VolcMessage(
            message_type=MessageType(case["message_type"]),
            event=EventType(case["event"]),
            payload=base64.b64decode(case["payload_b64"]),
            session_id=case.get("session_id"),
            connect_id=case.get("connect_id"),
        ).marshal()
    body = bytearray()
    if case["message_type"] == int(MessageType.ERROR):
        body.extend(struct.pack(">I", case["error_code"]))
    elif case["flags"] in {1, 3}:
        body.extend(struct.pack(">i", case["sequence"]))
    payload = base64.b64decode(case["payload_b64"])
    body.extend(struct.pack(">I", len(payload)))
    body.extend(payload)
    body.extend(base64.b64decode(case.get("trailing_b64", "")))
    return bytes((0x11, (case["message_type"] << 4) | case["flags"], 0, 0)) + body


def _tts_codec(case: Mapping[str, Any]) -> dict[str, Any]:
    wire = _tts_wire(case)
    try:
        message = VolcMessage.unmarshal(wire)
        result: Any = {
            "message_type": int(message.message_type),
            "event": None if message.event is None else int(message.event),
            "payload_b64": base64.b64encode(message.payload).decode(),
            "session_id": message.session_id,
            "connect_id": message.connect_id,
            "sequence": message.sequence,
            "error_code": message.error_code,
        }
    except VolcProtocolError as error:
        result = _safe_error(error)
    return {"frame_b64": base64.b64encode(wire).decode(), "result": result}


def _text_chunker(case: Mapping[str, Any]) -> dict[str, Any]:
    options: dict[str, int] = {}
    if "soft_limit" in case:
        options["soft_limit"] = case["soft_limit"]
    if "hard_limit" in case:
        options["hard_limit"] = case["hard_limit"]
    chunker = TextChunker(**options)
    emitted = [list(chunker.push(delta)) for delta in case["push"]]
    finished = list(chunker.finish()) if case.get("finish", False) else []
    return {"push": emitted, "finish": finished}


def produce() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return {
        "schema_version": document["schema_version"],
        "config": {case["id"]: _config_case(case) for case in document["config"]},
        "asr_encode": {case["id"]: _asr_encode(case) for case in document["asr_encode"]},
        "asr_decode": {case["id"]: _asr_decode(case) for case in document["asr_decode"]},
        "tts_codec": {case["id"]: _tts_codec(case) for case in document["tts_codec"]},
        "text_chunker": {case["id"]: _text_chunker(case) for case in document["text_chunker"]},
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", action="store_true")
    arguments = parser.parse_args(argv)
    produced = produce()
    if arguments.export:
        EXPECTED.write_text(
            json.dumps(produced, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print("exported Volcengine protocol golden")
        return 0
    if not EXPECTED.is_file():
        print(f"missing golden: {EXPECTED}", file=sys.stderr)
        return 1
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) != canonical_json(committed):
        print("Python Volcengine protocol does not match the committed golden", file=sys.stderr)
        return 1
    print("Python Volcengine protocol parity passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
