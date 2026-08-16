from __future__ import annotations

import argparse
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from .artifacts import render_report_markdown
from .evaluate import evaluate_interruption
from .fixtures import build_fixtures
from .models import ProbeEvent, ProbeReport, SCHEMA_VERSION
from .scenario import build_scenario


@dataclass(slots=True)
class AttemptPolicy:
    required_valid: int
    max_attempts: int
    attempts: int = 0
    valid_passes: int = 0
    terminal: str | None = None

    def observe(self, status: str) -> str:
        if self.terminal is not None:
            return self.terminal
        self.attempts += 1
        if status == "fail":
            self.terminal = "failed"
        elif status == "pass":
            self.valid_passes += 1
            if self.valid_passes >= self.required_valid:
                self.terminal = "succeeded"
        elif status != "harness_invalid":
            raise ValueError(f"unknown attempt status: {status}")
        if self.terminal is None and self.attempts >= self.max_attempts:
            self.terminal = "inconclusive"
        return self.terminal or "continue"


def resolve_api_key(env: Mapping[str, str], env_file: Path = Path(".env")) -> str:
    for name in ("DASHSCOPE_API_KEY", "NOVA_AUDIO_AGENT_MODEL_API_KEY"):
        value = env.get(name, "").strip()
        if value:
            return value
    values = dotenv_values(env_file) if env_file.exists() else {}
    for name in ("DASHSCOPE_API_KEY", "NOVA_AUDIO_AGENT_MODEL_API_KEY"):
        value = str(values.get(name) or "").strip()
        if value:
            return value
    return ""


def _dry_run(phase: str, arm: str | None) -> dict[str, object]:
    if phase == "history-recovery":
        assert arm == "history-packed"
        commands = [
            "session.update",
            "input_audio_buffer.append:auto-cancel-target",
            "response.cancel",
            "websocket.close:controlled",
            "session.update:reconnect",
        ]
        commands.append("conversation.item.create:dialogue-context")
        commands.extend(
            [
                "conversation.item.create:active-work-recovery",
                "conversation.item.create:guard-fact",
                "response.create:guard-fact",
            ]
        )
        return {
            "schema_version": SCHEMA_VERSION,
            "provider": "qwen",
            "phase": phase,
            "arm": arm,
            "experiment_id": f"qwen-{arm}.v1",
            "pair_budget": 4,
            "network_calls": 0,
            "outbound_event_types": commands,
        }
    if phase == "interruption" and arm == "auto-cancel-baseline":
        return {
            "schema_version": SCHEMA_VERSION,
            "provider": "qwen",
            "phase": phase,
            "arm": arm,
            "experiment_id": "qwen-auto-cancel-baseline.v1",
            "network_calls": 0,
            "outbound_event_types": [
                "session.update",
                "input_audio_buffer.append:auto_cancel_target",
                "response.cancel",
                "conversation.item.create:guard-fact",
                "response.create:guard-fact",
            ],
        }
    commands = [
        "session.update",
        "input_audio_buffer.append:delegate_request",
    ]
    if phase == "phase-a":
        commands.extend(
            [
                "input_audio_buffer.commit:delegate_request",
                "response.create:delegate_request",
            ]
        )
    commands.extend(
        [
            "conversation.item.create:delegate_acceptance",
            "response.create:delegate_ack",
        ]
    )
    if phase == "interruption":
        commands.extend(
            [
                "conversation.item.create:progress-1",
                "response.create:progress-1",
                "local.playback.stop",
                "response.cancel",
                "input_audio_buffer.append:barge_in",
            ]
        )
    steps = build_scenario(phase) if phase != "interruption" else []
    for step in steps:
        if step.kind == "progress":
            commands.extend(
                [
                    f"conversation.item.create:{step.step_id}",
                    f"response.create:{step.step_id}",
                ]
            )
            if phase == "full" and arm == "smart-cancel" and step.step_id == "progress-1":
                commands.extend(["local.playback.stop", "response.cancel"])
        elif step.kind in {"provenance", "barge_in", "recovery", "context_followup"}:
            commands.append(f"input_audio_buffer.append:{step.kind}")
        elif step.kind == "disconnect":
            commands.extend(["websocket.close:deliberate", "session.update:recovery"])
        elif step.kind == "final":
            commands.extend(["conversation.item.create:final", "response.create:final"])
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "provider": "qwen",
        "phase": phase,
        "network_calls": 0,
        "outbound_event_types": commands,
    }
    if arm is not None:
        payload["arm"] = arm
    if phase == "full" and arm == "smart-cancel":
        payload["experiment_id"] = "qwen-full-smart-cancel.v1"
    return payload


def _reevaluate(run_directory: Path) -> str:
    original = json.loads((run_directory / "report.json").read_text(encoding="utf-8"))
    if original.get("phase") != "interruption":
        raise ValueError("reevaluate currently supports interruption reports only")
    events = [
        ProbeEvent.from_dict(json.loads(line))
        for line in (run_directory / "trajectory.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    gate = evaluate_interruption(events)
    report = ProbeReport.for_run(
        provider=str(original.get("provider", "qwen")),
        model=str(original.get("model", "unknown")),
        phase="interruption",
        run_id=str(original.get("run_id", "unknown")),
        gates=[gate],
        metrics=(dict(original["metrics"]) if isinstance(original.get("metrics"), dict) else {}),
    ).to_dict()
    report["reevaluation"] = {
        "evaluator": "evaluate_interruption",
        "source_report": "report.json",
        "source_trajectory": "trajectory.jsonl",
    }
    markdown = render_report_markdown(report)
    (run_directory / "report.reevaluated.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (run_directory / "report.reevaluated.md").write_text(markdown, encoding="utf-8")
    return markdown


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Qwen/OpenAI realtime FrontBrain research probe")
    subparsers = parser.add_subparsers(dest="command", required=True)

    fixture = subparsers.add_parser("fixture", help="manage synthetic PCM fixtures")
    fixture_subcommands = fixture.add_subparsers(dest="fixture_command", required=True)
    fixture_build = fixture_subcommands.add_parser("build")
    fixture_build.add_argument("--output", type=Path, default=Path("data/realtime-probe/fixtures"))
    fixture_build.add_argument("--voice", default="Tingting")

    dry_run = subparsers.add_parser("dry-run", help="print the scripted wire order without network")
    dry_run.add_argument("--provider", choices=["qwen"], default="qwen")
    phases = ["phase-a", "full", "interruption", "history-recovery"]
    arms = ["smart-cancel", "auto-cancel-baseline", "history-packed"]
    dry_run.add_argument("--phase", choices=phases, required=True)
    dry_run.add_argument("--arm", choices=arms)
    dry_run.add_argument("--pairs", type=int, choices=[1, 2, 4], default=4)

    run = subparsers.add_parser("run", help="execute an opt-in live provider probe")
    run.add_argument("--provider", choices=["qwen"], default="qwen")
    run.add_argument("--phase", choices=phases, required=True)
    run.add_argument("--arm", choices=arms)
    run.add_argument("--pairs", type=int, choices=[1, 2, 4], default=4)
    run.add_argument("--runs", type=int, default=1)
    run.add_argument("--fixture-dir", type=Path, default=Path("data/realtime-probe/fixtures"))
    run.add_argument("--output", type=Path, default=Path("data/realtime-probe"))

    report = subparsers.add_parser("report", help="render report.md from a run directory")
    report.add_argument("run_directory", type=Path)
    reevaluate = subparsers.add_parser(
        "reevaluate",
        help="reevaluate an immutable interruption trajectory into sidecar reports",
    )
    reevaluate.add_argument("run_directory", type=Path)
    telemetry = subparsers.add_parser(
        "telemetry-report",
        help="render p50/p95/p99 metrics from a realtime telemetry JSONL file",
    )
    telemetry.add_argument("telemetry_file", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command in {"dry-run", "run"}:
        if args.phase == "interruption" and args.arm is None:
            parser.error("--phase interruption requires --arm smart-cancel or auto-cancel-baseline")
        if args.phase not in {"interruption", "full", "history-recovery"} and args.arm is not None:
            parser.error("--arm is only valid for interruption, full, or history-recovery")
        if args.phase == "full" and args.arm == "auto-cancel-baseline":
            parser.error("--arm auto-cancel-baseline is only valid for --phase interruption")
        if args.phase == "history-recovery" and args.arm != "history-packed":
            parser.error("--phase history-recovery requires --arm history-packed")
        if args.phase != "history-recovery" and args.arm == "history-packed":
            parser.error("history recovery arms require --phase history-recovery")
    if args.command == "fixture":
        fixtures = build_fixtures(args.output, voice=args.voice)
        print(
            json.dumps(
                {name: item.to_dict() for name, item in fixtures.items()},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    if args.command == "telemetry-report":
        from .telemetry_report import load_records, render_telemetry_report

        print(render_telemetry_report(load_records(args.telemetry_file)), end="")
        return 0
    if args.command == "dry-run":
        payload = _dry_run(args.phase, args.arm)
        if args.phase == "history-recovery":
            payload["pair_budget"] = args.pairs
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    if args.command == "report":
        report_path = args.run_directory / "report.json"
        value = json.loads(report_path.read_text(encoding="utf-8"))
        markdown = render_report_markdown(value)
        (args.run_directory / "report.md").write_text(markdown, encoding="utf-8")
        print(markdown, end="")
        return 0
    if args.command == "reevaluate":
        print(_reevaluate(args.run_directory), end="")
        return 0
    from .live import run_live_command

    return run_live_command(args, resolve_api_key(os.environ))
