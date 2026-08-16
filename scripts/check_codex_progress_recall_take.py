#!/usr/bin/env python3
"""Validate a completed Orb telemetry JSONL and emit a privacy-safe event stream."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
from pathlib import Path
from typing import Any

from nova_audio_agent.evals.codex_progress_recall import (
    MAX_EVIDENCE_RECORDS,
    MAX_MEMORY_REF_CHARS,
    evaluate_codex_progress_recall,
)

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_HARNESS_INVALID = 2

# Sized for a dense one-minute Orb recording while bounding hostile local inputs.
MAX_TELEMETRY_FILE_BYTES = 64 * 1024 * 1024
MAX_JSONL_LINE_BYTES = 1024 * 1024
MAX_MEMORY_BOARD_FILE_BYTES = 4 * 1024 * 1024
MAX_MEMORY_BOARD_CHANNELS = 64
MAX_MEMORY_BOARD_ITEMS_PER_CHANNEL = 50
MAX_MEMORY_BOARD_CHANNEL_NAME_CHARS = 64
_MEMORY_BOARD_TIMESTAMP_CHARS = 64
_MEMORY_BOARD_CHANNEL = re.compile(r"^[a-z][a-z0-9_]*$")
_MEMORY_REF = re.compile(r"^[a-z][a-z0-9_]*:[1-9][0-9]*$")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telemetry", type=Path, required=True)
    parser.add_argument("--memory-board", type=Path, required=True)
    parser.add_argument("--safe-events", type=Path, required=True)
    return parser.parse_args(argv)


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValueError("telemetry could not be read") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("telemetry must be a regular file")
        if metadata.st_size > MAX_TELEMETRY_FILE_BYTES:
            raise ValueError("telemetry file budget exceeded")
        total_bytes = 0
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            line_number = 0
            while line := handle.readline(MAX_JSONL_LINE_BYTES + 1):
                line_number += 1
                total_bytes += len(line)
                if len(line) > MAX_JSONL_LINE_BYTES:
                    raise ValueError("telemetry line budget exceeded")
                if total_bytes > MAX_TELEMETRY_FILE_BYTES:
                    raise ValueError("telemetry file budget exceeded")
                if len(records) >= MAX_EVIDENCE_RECORDS:
                    raise ValueError("telemetry record budget exceeded")
                try:
                    value: Any = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeError, RecursionError) as exc:
                    raise ValueError(f"telemetry line {line_number} is invalid JSON") from exc
                if not isinstance(value, dict):
                    raise ValueError(f"telemetry line {line_number} is not an object")
                records.append(value)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not records:
        raise ValueError("telemetry is empty")
    return records


def _read_memory_board_refs(path: Path) -> frozenset[str]:
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValueError("memory board could not be read") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("memory board must be a regular file")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            encoded = handle.read(MAX_MEMORY_BOARD_FILE_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(encoded) > MAX_MEMORY_BOARD_FILE_BYTES:
        raise ValueError("memory board file budget exceeded")
    try:
        board: Any = json.loads(encoded.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ValueError("memory board is invalid JSON") from exc
    if not isinstance(board, dict):
        raise ValueError("memory board must be an object")
    exported_at = board.get("exported_at")
    channels = board.get("channels")
    if (
        not isinstance(exported_at, str)
        or not exported_at
        or len(exported_at) > _MEMORY_BOARD_TIMESTAMP_CHARS
    ):
        raise ValueError("memory board exported_at is invalid")
    if not isinstance(channels, list) or len(channels) > MAX_MEMORY_BOARD_CHANNELS:
        raise ValueError("memory board channels are invalid")

    refs: set[str] = set()
    channel_names: set[str] = set()
    for channel in channels:
        if not isinstance(channel, dict):
            raise ValueError("memory board channel is invalid")
        name = channel.get("name")
        items = channel.get("items")
        if (
            not isinstance(name, str)
            or not name
            or len(name) > MAX_MEMORY_BOARD_CHANNEL_NAME_CHARS
            or _MEMORY_BOARD_CHANNEL.fullmatch(name) is None
        ):
            raise ValueError("memory board channel name is invalid")
        if name in channel_names:
            raise ValueError("memory board channel names must be unique")
        channel_names.add(name)
        if not isinstance(items, list) or len(items) > MAX_MEMORY_BOARD_ITEMS_PER_CHANNEL:
            raise ValueError("memory board items are invalid")
        sequences: set[int] = set()
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("memory board item is invalid")
            seq = item.get("seq")
            if type(seq) is not int or seq <= 0:
                raise ValueError("memory board item sequence is invalid")
            if seq in sequences:
                raise ValueError("memory board item sequences must be unique")
            sequences.add(seq)
            ref = f"{name}:{seq}"
            if len(ref) > MAX_MEMORY_REF_CHARS or _MEMORY_REF.fullmatch(ref) is None:
                raise ValueError("memory board item reference is invalid")
            refs.add(ref)
    return frozenset(refs)


def _write_safe_events(path: Path, events: tuple[dict[str, object], ...]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        for record in events:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def _print_report(report: object) -> None:
    gates = getattr(report, "gates")
    payload = {
        "backend": getattr(report, "backend"),
        "harness_valid": getattr(report, "harness_valid"),
        "passed": getattr(report, "passed"),
        "gates": [{"name": gate.name, "passed": gate.passed} for gate in gates],
        "timings_ms": dict(getattr(report, "timings_ms")),
        "invalid_reason": getattr(report, "invalid_reason"),
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        records = _read_jsonl(args.telemetry)
        board_refs = _read_memory_board_refs(args.memory_board)
    except ValueError as exc:
        print(json.dumps({"status": "harness_invalid", "reason": str(exc)}))
        return EXIT_HARNESS_INVALID
    report = evaluate_codex_progress_recall(
        records,
        backend="orb_live",
        board_refs=board_refs,
    )
    _print_report(report)
    if not report.harness_valid:
        return EXIT_HARNESS_INVALID
    try:
        _write_safe_events(args.safe_events, report.safe_events)
    except OSError:
        print(json.dumps({"status": "harness_invalid", "reason": "safe-events write failed"}))
        return EXIT_HARNESS_INVALID
    return EXIT_PASS if report.passed else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
