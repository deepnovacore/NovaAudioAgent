from __future__ import annotations

import json
import wave
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from scripts.realtime_probe.artifacts import ArtifactWriter, sanitize_provider_event
from scripts.realtime_probe.cli import AttemptPolicy, main, resolve_api_key
from scripts.realtime_probe.fixtures import FIXTURE_TEXT, build_fixtures, validate_pcm
from scripts.realtime_probe.models import GateResult, ProbeEvent, ProbeReport


def fake_command_runner(command: list[str], **kwargs: object) -> CompletedProcess[str]:
    if command[0].endswith("say"):
        output = Path(command[command.index("-o") + 1])
        output.write_bytes(b"fake-aiff")
    elif command[0].endswith("ffmpeg"):
        Path(command[-1]).write_bytes(b"\x00\x00\x01\x00" * 800)
    return CompletedProcess(command, 0, "", "")


def probe_event(
    event_ref: str,
    t_ms: int,
    kind: str,
    *,
    actor: str = "host",
    provider: dict[str, str] | None = None,
    **data: object,
) -> ProbeEvent:
    return ProbeEvent(
        event_ref=event_ref,
        t_ms=t_ms,
        kind=kind,
        actor=actor,
        run_id="run-1",
        delegate_id="delegate-1",
        provider=provider or {},
        data=data,
    )


def test_fixture_builder_produces_stable_valid_pcm(tmp_path: Path) -> None:
    first = build_fixtures(
        tmp_path / "first",
        command_runner=fake_command_runner,
        which=lambda name: f"/usr/bin/{name}",
    )
    second = build_fixtures(
        tmp_path / "second",
        command_runner=fake_command_runner,
        which=lambda name: f"/usr/bin/{name}",
    )

    assert set(first) == set(FIXTURE_TEXT)
    assert first["delegate_request"].sha256 == second["delegate_request"].sha256
    assert first["delegate_request"].sample_rate == 16_000
    assert first["delegate_request"].sample_width == 2
    assert first["delegate_request"].channels == 1


def test_fixture_builder_fails_fast_when_tool_is_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="ffmpeg"):
        build_fixtures(
            tmp_path,
            command_runner=fake_command_runner,
            which=lambda name: None if name == "ffmpeg" else f"/usr/bin/{name}",
        )


def test_pcm_validation_rejects_empty_and_odd_files(tmp_path: Path) -> None:
    empty = tmp_path / "empty.pcm"
    empty.write_bytes(b"")
    odd = tmp_path / "odd.pcm"
    odd.write_bytes(b"\x00")

    with pytest.raises(ValueError, match="non-empty"):
        validate_pcm(empty)
    with pytest.raises(ValueError, match="16-bit"):
        validate_pcm(odd)


def test_provider_audio_is_replaced_by_hash_metadata() -> None:
    sanitized = sanitize_provider_event(
        {"type": "response.audio.delta", "response_id": "r1", "delta": "AAE="}
    )

    assert sanitized["response_id"] == "r1"
    assert sanitized["delta"]["decoded_bytes"] == 2
    assert len(sanitized["delta"]["sha256"]) == 64


def test_usage_token_counts_are_not_mistaken_for_credentials(tmp_path: Path) -> None:
    writer = ArtifactWriter(tmp_path)

    writer.write_manifest(
        {"usage": {"input_tokens": 123, "output_tokens": 45, "total_tokens": 168}}
    )

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["usage"] == {
        "input_tokens": 123,
        "output_tokens": 45,
        "total_tokens": 168,
    }


def test_output_audio_is_written_as_pcm_and_24khz_wav(tmp_path: Path) -> None:
    writer = ArtifactWriter(tmp_path)
    pcm = b"\x01\x00\x02\x00"

    pcm_path = writer.write_audio("progress 1", pcm)

    assert pcm_path == tmp_path / "output" / "progress_1.pcm"
    assert pcm_path.read_bytes() == pcm
    wav_path = pcm_path.with_suffix(".wav")
    with wave.open(str(wav_path), "rb") as wav_file:
        assert wav_file.getframerate() == 24_000
        assert wav_file.getsampwidth() == 2
        assert wav_file.getnchannels() == 1
        assert wav_file.readframes(wav_file.getnframes()) == pcm


def test_input_fixture_is_copied_into_the_private_attempt_directory(tmp_path: Path) -> None:
    writer = ArtifactWriter(tmp_path)
    pcm = b"\x01\x00\x02\x00"

    path = writer.write_input_fixture("delegate request", pcm)

    assert path == tmp_path / "input" / "delegate_request.pcm"
    assert path.read_bytes() == pcm


def test_artifacts_never_persist_secret_fields(tmp_path: Path) -> None:
    writer = ArtifactWriter(tmp_path)
    secret = "dashscope-secret-value"
    events = [
        ProbeEvent(
            event_ref="e1",
            t_ms=1,
            kind="provider.session_created",
            actor="provider",
            run_id="run-1",
            delegate_id="delegate-1",
            data={},
        )
    ]
    report = ProbeReport.for_run(
        provider="qwen",
        model="qwen-audio-3.0-realtime-plus",
        phase="phase-a",
        run_id="run-1",
        gates=[GateResult(4, "external_event_injection", "pass")],
    )

    writer.write_manifest(
        {"model": "qwen-audio-3.0-realtime-plus", "authorization": f"Bearer {secret}"}
    )
    writer.write_provider_events(
        [{"type": "error", "error": {"message": secret}, "api_key": secret}]
    )
    writer.write_trajectory(events)
    writer.write_report(report)

    persisted = "\n".join(path.read_text(errors="ignore") for path in tmp_path.rglob("*.*"))
    assert secret not in persisted
    assert "<redacted>" in persisted


def test_key_resolution_prefers_dashscope_and_falls_back_to_nova(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "DASHSCOPE_API_KEY=from-file-dashscope\nNOVA_AUDIO_AGENT_MODEL_API_KEY=from-file-nova\n"
    )

    assert resolve_api_key({"DASHSCOPE_API_KEY": "from-env"}, env_file) == "from-env"
    assert resolve_api_key({}, env_file) == "from-file-dashscope"
    env_file.write_text("NOVA_AUDIO_AGENT_MODEL_API_KEY=from-file-nova\n")
    assert resolve_api_key({}, env_file) == "from-file-nova"


def test_phase_a_attempt_policy_retries_invalid_but_stops_on_semantic_failure() -> None:
    policy = AttemptPolicy(required_valid=3, max_attempts=6)

    assert policy.observe("harness_invalid") == "continue"
    assert policy.observe("pass") == "continue"
    assert policy.observe("pass") == "continue"
    assert policy.observe("pass") == "succeeded"

    failed = AttemptPolicy(required_valid=3, max_attempts=6)
    assert failed.observe("pass") == "continue"
    assert failed.observe("fail") == "failed"


def test_dry_run_cli_prints_ordered_documented_commands_without_a_key(capsys: object) -> None:
    exit_code = main(["dry-run", "--provider", "qwen", "--phase", "phase-a"])
    captured = capsys.readouterr()  # type: ignore[attr-defined]
    payload = json.loads(captured.out)

    assert exit_code == 0
    assert payload["schema_version"] == "realtime-probe.v1"
    assert payload["provider"] == "qwen"
    commands = payload["outbound_event_types"]
    assert commands.index("conversation.item.create:progress-1") < commands.index(
        "response.create:progress-1"
    )
    assert "api_key" not in captured.out.lower()


def test_full_dry_run_uses_smart_turn_without_manual_commit(capsys: object) -> None:
    exit_code = main(["dry-run", "--provider", "qwen", "--phase", "full"])
    captured = capsys.readouterr()  # type: ignore[attr-defined]
    commands = json.loads(captured.out)["outbound_event_types"]

    assert exit_code == 0
    assert "input_audio_buffer.commit:delegate_request" not in commands
    assert "response.create:delegate_request" not in commands


def test_interruption_dry_run_declares_stop_cancel_then_audio(capsys: object) -> None:
    exit_code = main(
        [
            "dry-run",
            "--provider",
            "qwen",
            "--phase",
            "interruption",
            "--arm",
            "smart-cancel",
        ]
    )
    payload = json.loads(capsys.readouterr().out)  # type: ignore[attr-defined]
    commands = payload["outbound_event_types"]

    assert exit_code == 0
    assert payload["network_calls"] == 0
    assert "credential" not in json.dumps(payload).lower()
    assert commands.index("local.playback.stop") < commands.index("response.cancel")
    assert commands.index("response.cancel") < commands.index("input_audio_buffer.append:barge_in")


def test_auto_cancel_baseline_dry_run_has_no_target_response_create(
    capsys: object,
) -> None:
    exit_code = main(
        [
            "dry-run",
            "--provider",
            "qwen",
            "--phase",
            "interruption",
            "--arm",
            "auto-cancel-baseline",
        ]
    )
    payload = json.loads(capsys.readouterr().out)  # type: ignore[attr-defined]
    commands = payload["outbound_event_types"]

    assert exit_code == 0
    assert payload["experiment_id"] == "qwen-auto-cancel-baseline.v1"
    cancel_index = commands.index("response.cancel")
    assert "response.create" not in " ".join(commands[:cancel_index])
    assert commands[:cancel_index] == [
        "session.update",
        "input_audio_buffer.append:auto_cancel_target",
    ]
    assert commands[cancel_index + 1 :] == [
        "conversation.item.create:guard-fact",
        "response.create:guard-fact",
    ]


def test_history_recovery_dry_run_declares_bounded_replay_before_guard(
    capsys: object,
) -> None:
    arm = "history-packed"
    history_commands = ["conversation.item.create:dialogue-context"]
    exit_code = main(
        [
            "dry-run",
            "--provider",
            "qwen",
            "--phase",
            "history-recovery",
            "--arm",
            arm,
            "--pairs",
            "2",
        ]
    )
    payload = json.loads(capsys.readouterr().out)  # type: ignore[attr-defined]

    assert exit_code == 0
    assert payload["experiment_id"] == f"qwen-{arm}.v1"
    assert payload["pair_budget"] == 2
    commands = payload["outbound_event_types"]
    history_indexes = [commands.index(command) for command in history_commands]
    assert history_indexes == sorted(history_indexes)
    assert max(history_indexes) < commands.index("conversation.item.create:active-work-recovery")
    assert commands[-2:] == [
        "conversation.item.create:guard-fact",
        "response.create:guard-fact",
    ]


def test_integrated_full_dry_run_declares_registered_smart_cancel_arm(
    capsys: object,
) -> None:
    exit_code = main(
        [
            "dry-run",
            "--provider",
            "qwen",
            "--phase",
            "full",
            "--arm",
            "smart-cancel",
        ]
    )
    payload = json.loads(capsys.readouterr().out)  # type: ignore[attr-defined]
    commands = payload["outbound_event_types"]

    assert exit_code == 0
    assert payload["experiment_id"] == "qwen-full-smart-cancel.v1"
    assert commands.index("response.create:progress-1") < commands.index("local.playback.stop")
    assert commands.index("local.playback.stop") < commands.index("response.cancel")
    assert commands.index("response.cancel") < commands.index("input_audio_buffer.append:barge_in")


def test_interruption_phase_requires_the_registered_arm() -> None:
    with pytest.raises(SystemExit):
        main(["dry-run", "--provider", "qwen", "--phase", "interruption"])


def test_phase_a_rejects_an_arm() -> None:
    with pytest.raises(SystemExit):
        main(
            [
                "dry-run",
                "--provider",
                "qwen",
                "--phase",
                "phase-a",
                "--arm",
                "smart-cancel",
            ]
        )


def test_reevaluate_writes_sidecar_without_overwriting_original_report(
    tmp_path: Path, capsys: object
) -> None:
    run_directory = tmp_path / "attempt-01"
    writer = ArtifactWriter(run_directory)
    events = [
        probe_event(
            "e0001",
            10,
            "provider.audio_delta",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
        ),
        probe_event(
            "e0002",
            20,
            "local.playback_rendered",
            provider={"response_id": "progress-r"},
            purpose="progress",
        ),
        probe_event(
            "e0003",
            30,
            "local.speech_onset",
            actor="user",
            provider={"response_id": "progress-r"},
            purpose="barge_in",
        ),
        probe_event(
            "e0004",
            31,
            "local.playback_stopped",
            provider={"response_id": "progress-r"},
            purpose="progress",
            rendered_after_fence_bytes=0,
        ),
        probe_event(
            "e0005",
            32,
            "host.response_cancel",
            provider={"response_id": "progress-r"},
            purpose="progress",
        ),
        probe_event(
            "e0006",
            40,
            "provider.response_cancelled",
            actor="provider",
            provider={"response_id": "progress-r"},
            purpose="progress",
            status="cancelled",
            status_details={"reason": "client_cancelled"},
        ),
        probe_event(
            "e0007",
            50,
            "provider.audio_delta",
            actor="provider",
            provider={"response_id": "foreground-r"},
            purpose="foreground",
        ),
        probe_event(
            "e0008",
            60,
            "assistant.transcript",
            actor="provider",
            provider={"response_id": "foreground-r"},
            purpose="foreground",
            text="七乘八等于五十六。",
        ),
        probe_event(
            "e0009",
            70,
            "provider.user_transcript",
            actor="user",
            provider={"item_id": "barge-item"},
            purpose="barge_in",
            text="顺便问一下，七乘八是多少？",
        ),
        probe_event(
            "e0010",
            80,
            "host.delegate_status",
            delegate_status="running",
        ),
    ]
    original = ProbeReport.for_run(
        provider="qwen",
        model="qwen-audio-3.0-realtime-plus",
        phase="interruption",
        run_id="run-1",
        gates=[
            GateResult(
                3,
                "foreground_interruption",
                "fail",
                ["interruption_order_invalid"],
            )
        ],
        metrics={"onset_to_playback_stop_ms": 1},
    )
    writer.write_trajectory(events)
    writer.write_report(original)

    exit_code = main(["reevaluate", str(run_directory)])

    captured = capsys.readouterr()  # type: ignore[attr-defined]
    original_value = json.loads((run_directory / "report.json").read_text())
    reevaluated = json.loads((run_directory / "report.reevaluated.json").read_text())
    assert exit_code == 0
    assert original_value["status"] == "fail"
    assert original_value["gates"][0]["reason_codes"] == ["interruption_order_invalid"]
    assert reevaluated["status"] == "pass"
    assert reevaluated["gates"][0]["reason_codes"] == []
    assert reevaluated["metrics"] == {"onset_to_playback_stop_ms": 1}
    assert reevaluated["reevaluation"] == {
        "evaluator": "evaluate_interruption",
        "source_report": "report.json",
        "source_trajectory": "trajectory.jsonl",
    }
    assert (run_directory / "report.reevaluated.md").is_file()
    assert "Status: **pass**" in captured.out
