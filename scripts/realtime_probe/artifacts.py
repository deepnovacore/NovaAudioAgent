from __future__ import annotations

import base64
import hashlib
import json
import re
import wave
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from .models import ProbeEvent, ProbeReport


_SENSITIVE_KEY = re.compile(
    r"(?:^|[_-])(?:api[_-]?key|authorization|bearer|secret|token|"
    r"(?:access|refresh|auth|session)[_-]?token)(?:$|[_-])",
    re.IGNORECASE,
)


def _sanitize(value: Any, *, parent_key: str = "") -> Any:
    if _SENSITIVE_KEY.search(parent_key):
        return "<redacted>"
    if isinstance(value, Mapping):
        return {str(key): _sanitize(item, parent_key=str(key)) for key, item in value.items()}
    if isinstance(value, list):
        return [_sanitize(item, parent_key=parent_key) for item in value]
    return value


def sanitize_provider_event(event: Mapping[str, Any]) -> dict[str, Any]:
    sanitized = _sanitize(dict(event))
    event_type = str(event.get("type", ""))
    if event_type == "response.audio.delta" and isinstance(event.get("delta"), str):
        try:
            decoded = base64.b64decode(event["delta"], validate=True)
            sanitized["delta"] = {
                "decoded_bytes": len(decoded),
                "sha256": hashlib.sha256(decoded).hexdigest(),
            }
        except ValueError:
            sanitized["delta"] = {"invalid_base64": True}
    if event_type == "error" and isinstance(sanitized.get("error"), dict):
        sanitized["error"]["message"] = "<redacted>"
    return sanitized


def render_report_markdown(report: Mapping[str, Any]) -> str:
    lines = [
        f"# Realtime Probe Report: {report.get('run_id', 'unknown')}",
        "",
        f"- Provider: `{report.get('provider', 'unknown')}`",
        f"- Model: `{report.get('model', 'unknown')}`",
        f"- Phase: `{report.get('phase', 'unknown')}`",
        f"- Status: **{report.get('status', 'unknown')}**",
        f"- Schema: `{report.get('schema_version', 'unknown')}`",
        "- Human transcript/audio review: required before a product-line conclusion",
        "",
        "## Gates",
        "",
        "| Gate | Name | Status | Reasons | Evidence |",
        "|---:|---|---|---|---|",
    ]
    for gate in report.get("gates", []):
        reasons = ", ".join(gate.get("reason_codes", [])) or "—"
        evidence = ", ".join(gate.get("evidence_refs", [])) or "—"
        lines.append(
            f"| {gate.get('gate')} | {gate.get('name')} | {gate.get('status')} | "
            f"{reasons} | {evidence} |"
        )
    metrics = report.get("metrics", {})
    if metrics:
        lines.extend(
            [
                "",
                "## Metrics",
                "",
                "```json",
                json.dumps(metrics, ensure_ascii=False, indent=2),
                "```",
            ]
        )
    return "\n".join(lines) + "\n"


class ArtifactWriter:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _write_json(path: Path, value: object) -> None:
        path.write_text(
            json.dumps(_sanitize(value), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _write_jsonl(path: Path, values: Iterable[object]) -> None:
        path.write_text(
            "".join(
                json.dumps(_sanitize(value), ensure_ascii=False, sort_keys=True) + "\n"
                for value in values
            ),
            encoding="utf-8",
        )

    def write_manifest(self, manifest: Mapping[str, Any]) -> Path:
        path = self.root / "manifest.json"
        self._write_json(path, manifest)
        return path

    def write_provider_events(self, events: Iterable[Mapping[str, Any]]) -> Path:
        path = self.root / "provider-events.jsonl"
        self._write_jsonl(path, (sanitize_provider_event(event) for event in events))
        return path

    def write_trajectory(self, events: Iterable[ProbeEvent]) -> Path:
        path = self.root / "trajectory.jsonl"
        self._write_jsonl(path, (event.to_dict() for event in events))
        return path

    def write_report(self, report: ProbeReport) -> tuple[Path, Path]:
        value = report.to_dict()
        json_path = self.root / "report.json"
        markdown_path = self.root / "report.md"
        self._write_json(json_path, value)
        markdown_path.write_text(render_report_markdown(value), encoding="utf-8")
        return json_path, markdown_path

    def write_input_fixture(self, name: str, pcm: bytes) -> Path:
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", name)
        path = self.root / "input" / f"{safe_name}.pcm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pcm)
        return path

    def write_audio(self, name: str, pcm: bytes) -> Path | None:
        if not pcm:
            return None
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", name)
        path = self.root / "output" / f"{safe_name}.pcm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pcm)
        with wave.open(str(path.with_suffix(".wav")), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(24_000)
            wav_file.writeframes(pcm)
        return path
