from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.config import ConfigurationError
from nova_audio_agent.memory import Memory, parse_ref
from scripts import check_codex_progress_recall_take as take_cli
from scripts import eval_codex_progress_recall_live as live_cli
from test_eval_codex_progress_recall import passing_records


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )


def _write_board(path: Path, refs: tuple[str, ...] = ("codex:2", "codex:3")) -> None:
    grouped: dict[str, list[int]] = {}
    for ref in refs:
        channel, seq = parse_ref(ref)
        grouped.setdefault(channel, []).append(seq)
    path.write_text(
        json.dumps(
            {
                "exported_at": "2026-08-16T00:00:00.000Z",
                "channels": [
                    {
                        "name": channel,
                        "items": [{"seq": seq, "content": "SECRET"} for seq in seqs],
                    }
                    for channel, seqs in grouped.items()
                ],
            }
        ),
        encoding="utf-8",
    )


def test_live_runner_requires_consent_before_live_harness_construction(
    monkeypatch: object,
    tmp_path: Path,
    capsys: object,
) -> None:
    called = False

    def forbidden(_args: object) -> int:
        nonlocal called
        called = True
        raise AssertionError("provider construction must be unreachable without consent")

    monkeypatch.setattr(live_cli, "_run_live", forbidden)  # type: ignore[attr-defined]
    artifacts = tmp_path / "artifacts"

    exit_code = live_cli.main(["--artifacts", str(artifacts)])

    assert exit_code == 2
    assert called is False
    assert artifacts.exists() is False
    assert capsys.readouterr().out.strip() == (  # type: ignore[attr-defined]
        "consent required: synthetic origin, two progress facts, and question audio; "
        "pass --consent-send-synthetic-facts before contacting providers"
    )


def test_live_runner_contracts_exact_fixed_facts_and_no_workspace_argument() -> None:
    assert live_cli.SYNTHETIC_PROGRESS_FACTS == (
        "检查现有页面后确认：旧版本只把笔记保存在页面内存中，刷新会丢失",
        "自动保存与刷新恢复已完成，Node 测试全部通过",
    )
    assert "workspace" not in vars(live_cli._parse_args(["--artifacts", "/tmp/artifacts"]))


def test_synthetic_delegate_origin_is_a_canonical_conversation_memory_item() -> None:
    dispatched: list[object] = []
    runtime = SimpleNamespace(
        clock=VirtualClock(),
        memory=Memory(),
        delegates=SimpleNamespace(dispatch=dispatched.append),
    )

    delegate = live_cli._bind_synthetic_delegate(runtime)

    assert dispatched == [delegate]
    assert delegate.origin_ref == "conversation:1"
    channel, seq = parse_ref(delegate.origin_ref)
    origin = runtime.memory.channels[channel].items[seq - 1]
    assert origin.ref == delegate.origin_ref
    assert origin.content == {"text": "检查笔记刷新后丢失的原因，并验证自动保存和刷新恢复。"}


@pytest.mark.asyncio
async def test_live_exercise_has_one_service_owned_runtime_lifecycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class _Clock:
        def now(self) -> float:
            return 0.0

    class _Delegates:
        def dispatch(self, _delegate: object) -> None:
            events.append("delegate.dispatch")

    class _Runtime:
        clock = _Clock()
        memory = Memory()
        delegates = _Delegates()
        serve_calls = 0

        def post(self, _event: object) -> None:
            return None

        async def serve(self, _stop: object) -> None:
            self.serve_calls += 1

    class _Telemetry:
        records = passing_records()

        def record(self, _kind: str, _payload: dict[str, object]) -> None:
            return None

        def payloads(self, kind: str) -> tuple[dict[str, object], ...]:
            return tuple(
                record["payload"]  # type: ignore[misc]
                for record in self.records
                if record["kind"] == kind
            )

    class _Service:
        start_calls = 0
        close_calls = 0

        async def start(self) -> None:
            self.start_calls += 1
            events.append("service.start")

        async def close(self) -> None:
            self.close_calls += 1

        async def flush_host_items(self) -> None:
            return None

    class _Provider:
        activation: tuple[object, bool] | None = None

        async def inject_host_item(
            self,
            item: object,
            *,
            as_user_activation: bool = False,
        ) -> None:
            self.activation = (item, as_user_activation)
            events.append("provider.activate")

    runtime = _Runtime()
    service = _Service()
    telemetry = _Telemetry()
    renderer = SimpleNamespace(deliveries=[object(), object()])
    provider = _Provider()
    monkeypatch.setattr(live_cli, "Settings", lambda **_kwargs: object())
    monkeypatch.setattr(
        live_cli,
        "_preflight",
        lambda _settings, *, timeout: ("endpoint", "model", "voice", "rt-key", "model-key"),
    )
    monkeypatch.setattr(live_cli, "_synthesize_question", lambda *_args, **_kwargs: b"\0\0")
    monkeypatch.setattr(
        live_cli,
        "_build_live_harness",
        lambda *_args, **_kwargs: (runtime, service, telemetry, renderer, provider),
    )

    async def no_wait(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(live_cli, "_wait_for_records", no_wait)
    monkeypatch.setattr(live_cli, "_wait_for_deliveries", no_wait)
    monkeypatch.setattr(live_cli, "_stream_question", no_wait)
    args = live_cli._parse_args(
        ["--consent-send-synthetic-facts", "--artifacts", "/tmp/unused-task7-lifecycle"]
    )

    await live_cli._exercise_live(args)

    assert service.start_calls == 1
    assert service.close_calls == 1
    assert runtime.serve_calls == 0
    assert events[:3] == ["service.start", "provider.activate", "delegate.dispatch"]
    activation = provider.activation
    assert activation is not None
    item, as_user_activation = activation
    assert item.kind == "progress"  # type: ignore[union-attr]
    assert item.content == live_cli.SYNTHETIC_ORIGIN_TEXT  # type: ignore[union-attr]
    assert as_user_activation is True


def test_live_telemetry_has_explicit_count_and_byte_budgets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = SimpleNamespace(now=lambda: 0.0)
    assert live_cli.MAX_LIVE_TELEMETRY_RECORDS >= 20_000
    assert live_cli.MAX_LIVE_TELEMETRY_BYTES >= 8 * 1024 * 1024
    monkeypatch.setattr(live_cli, "MAX_LIVE_TELEMETRY_RECORDS", 1)
    telemetry = live_cli._Telemetry(clock)
    telemetry.record("codex.dispatch", {"delegate_id": "d-1"})
    with pytest.raises(live_cli.HarnessInvalid, match="telemetry budget"):
        telemetry.record("codex.dispatch", {"delegate_id": "d-2"})

    monkeypatch.setattr(live_cli, "MAX_LIVE_TELEMETRY_RECORDS", 10)
    monkeypatch.setattr(live_cli, "MAX_LIVE_TELEMETRY_BYTES", 10)
    byte_limited = live_cli._Telemetry(clock)
    with pytest.raises(live_cli.HarnessInvalid, match="telemetry budget"):
        byte_limited.record("codex.dispatch", {"delegate_id": "d-1"})


def test_audio_synthesis_subprocesses_receive_the_cli_timeout(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    timeouts: list[float] = []

    def run(command: list[str], **kwargs: object) -> object:
        timeouts.append(kwargs["timeout"])  # type: ignore[arg-type]
        output = command[4] if command[0] == "say" else command[-1]
        Path(output).write_bytes(b"\0\0")
        return object()

    monkeypatch.setattr(live_cli.subprocess, "run", run)

    assert live_cli._synthesize_question(tmp_path, timeout=1.25) == b"\0\0"
    assert timeouts == [1.25, 1.25]


@pytest.mark.asyncio
async def test_bounded_await_times_out_without_provider_or_network() -> None:
    with pytest.raises(live_cli.HarnessInvalid, match="bounded operation timed out"):
        await live_cli._await_bounded(
            asyncio.sleep(60),
            timeout=0.001,
            failure="bounded operation timed out",
        )


@pytest.mark.parametrize(
    "failure",
    (
        lambda: ConfigurationError("SUPER-SECRET-CONFIG"),
        lambda: RuntimeError("SUPER-SECRET-CONSTRUCTION"),
        lambda: live_cli.Settings(_env_file=None, qwen_guard_history_pairs=3),
    ),
)
def test_consented_runner_maps_config_and_construction_failures_to_safe_exit_two(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: object,
) -> None:
    def fail(_args: object) -> int:
        value = failure()  # type: ignore[operator]
        if isinstance(value, BaseException):
            raise value
        raise AssertionError("expected settings validation to raise")

    monkeypatch.setattr(live_cli, "_run_live", fail)

    exit_code = live_cli.main(
        ["--consent-send-synthetic-facts", "--artifacts", "/tmp/unused-task7-failure"]
    )

    output = capsys.readouterr().out
    assert exit_code == 2
    assert "SUPER-SECRET" not in output
    assert json.loads(output)["reason"] == "live_harness_invalid"


def test_existing_artifact_directory_fails_before_live_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    artifacts = tmp_path / "existing"
    artifacts.mkdir()
    called = False

    async def exercise(_args: object) -> object:
        nonlocal called
        called = True
        return object()

    monkeypatch.setattr(live_cli, "_exercise_live", exercise)

    with pytest.raises(live_cli.HarnessInvalid, match="artifacts"):
        live_cli._run_live(
            live_cli._parse_args(
                [
                    "--consent-send-synthetic-facts",
                    "--artifacts",
                    str(artifacts),
                ]
            )
        )

    assert called is False


def test_offline_take_validator_writes_only_safe_events(tmp_path: Path) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    records = passing_records()
    records.insert(
        1,
        {
            "ts": 0.5,
            "kind": "provider.response_started",
            "payload": {"response_id": "NEVER-EXPOSE-PROVIDER"},
        },
    )
    _write_jsonl(telemetry, records)
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 0
    serialized = safe_events.read_text(encoding="utf-8")
    assert "NEVER-EXPOSE" not in serialized
    assert "renderer-selected" not in serialized
    assert "suggestion:s-1" not in serialized
    assert "query_digest" not in serialized
    assert len(serialized.splitlines()) == len(passing_records())


def test_offline_take_validator_cross_checks_memory_board_without_leaking_content(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_jsonl(telemetry, passing_records())
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 0
    assert "SECRET" not in capsys.readouterr().out
    assert "SECRET" not in safe_events.read_text(encoding="utf-8")


def test_offline_take_validator_returns_one_when_board_omits_declined_ref(tmp_path: Path) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_jsonl(telemetry, passing_records())
    _write_board(board, ("codex:3",))

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 1
    assert safe_events.is_file()


@pytest.mark.parametrize(
    "malformed",
    (
        "symlink",
        "fifo",
        "directory",
        "invalid_json",
        "oversized",
        "duplicate_channel",
        "duplicate_sequence",
        "invalid_channel",
        "nonpositive_sequence",
        "overlong_reference",
    ),
)
def test_offline_take_validator_rejects_malformed_memory_board_without_output(
    tmp_path: Path,
    malformed: str,
) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_jsonl(telemetry, passing_records())
    if malformed == "symlink":
        source = tmp_path / "source-board.json"
        _write_board(source)
        board.symlink_to(source)
    elif malformed == "fifo":
        os.mkfifo(board)
    elif malformed == "directory":
        board.mkdir()
    elif malformed == "invalid_json":
        board.write_text("{", encoding="utf-8")
    elif malformed == "oversized":
        with board.open("wb") as handle:
            handle.truncate(take_cli.MAX_MEMORY_BOARD_FILE_BYTES + 1)
    elif malformed == "duplicate_channel":
        board.write_text(
            json.dumps(
                {
                    "exported_at": "2026-08-16T00:00:00.000Z",
                    "channels": [
                        {"name": "codex", "items": [{"seq": 2}]},
                        {"name": "codex", "items": [{"seq": 3}]},
                    ],
                }
            ),
            encoding="utf-8",
        )
    elif malformed == "duplicate_sequence":
        board.write_text(
            json.dumps(
                {
                    "exported_at": "2026-08-16T00:00:00.000Z",
                    "channels": [{"name": "codex", "items": [{"seq": 2}, {"seq": 2}]}],
                }
            ),
            encoding="utf-8",
        )
    elif malformed == "invalid_channel":
        board.write_text(
            json.dumps(
                {
                    "exported_at": "2026-08-16T00:00:00.000Z",
                    "channels": [{"name": "invalid-channel", "items": [{"seq": 2}]}],
                }
            ),
            encoding="utf-8",
        )
    elif malformed == "nonpositive_sequence":
        board.write_text(
            json.dumps(
                {
                    "exported_at": "2026-08-16T00:00:00.000Z",
                    "channels": [{"name": "codex", "items": [{"seq": 0}]}],
                }
            ),
            encoding="utf-8",
        )
    else:
        board.write_text(
            json.dumps(
                {
                    "exported_at": "2026-08-16T00:00:00.000Z",
                    "channels": [{"name": "codex", "items": [{"seq": int("9" * 160)}]}],
                }
            ),
            encoding="utf-8",
        )

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 2
    assert safe_events.exists() is False


def test_offline_take_validator_returns_one_for_semantic_gate_failure(tmp_path: Path) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    records = passing_records()
    records.pop(1)
    _write_jsonl(telemetry, records)
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 1
    assert safe_events.is_file()


def test_offline_take_validator_returns_two_without_writing_on_privacy_failure(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    records = copy.deepcopy(passing_records())
    payload = records[1]["payload"]
    assert isinstance(payload, dict)
    payload["reason"] = "NEVER-EXPOSE"
    _write_jsonl(telemetry, records)
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 2
    assert safe_events.exists() is False


def test_offline_take_validator_rejects_invalid_jsonl(tmp_path: Path) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    telemetry.write_text('{"ts": 0}\nnot-json\n', encoding="utf-8")
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 2
    assert safe_events.exists() is False


def test_offline_reader_streams_without_path_read_text(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_jsonl(telemetry, passing_records())
    _write_board(board)

    def forbidden(*_args: object, **_kwargs: object) -> str:
        raise AssertionError("bounded reader must not call Path.read_text")

    monkeypatch.setattr(Path, "read_text", forbidden)

    assert (
        take_cli.main(
            [
                "--telemetry",
                str(telemetry),
                "--memory-board",
                str(board),
                "--safe-events",
                str(safe_events),
            ]
        )
        == 0
    )


@pytest.mark.parametrize("kind", ("symlink", "fifo", "directory"))
def test_offline_reader_rejects_nonregular_inputs_without_output(
    tmp_path: Path,
    kind: str,
) -> None:
    source = tmp_path / "source.jsonl"
    _write_jsonl(source, passing_records())
    telemetry = tmp_path / kind
    if kind == "symlink":
        telemetry.symlink_to(source)
    elif kind == "fifo":
        os.mkfifo(telemetry)
    else:
        telemetry.mkdir()
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_board(board)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 2
    assert safe_events.exists() is False


def test_offline_reader_rejects_file_and_line_overflow(tmp_path: Path) -> None:
    assert take_cli.MAX_TELEMETRY_FILE_BYTES >= 32 * 1024 * 1024
    assert take_cli.MAX_JSONL_LINE_BYTES >= 256 * 1024
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_board(board)
    oversized_file = tmp_path / "oversized-file.jsonl"
    with oversized_file.open("wb") as handle:
        handle.truncate(take_cli.MAX_TELEMETRY_FILE_BYTES + 1)
    assert (
        take_cli.main(
            [
                "--telemetry",
                str(oversized_file),
                "--memory-board",
                str(board),
                "--safe-events",
                str(safe_events),
            ]
        )
        == 2
    )
    assert safe_events.exists() is False

    oversized_line = tmp_path / "oversized-line.jsonl"
    oversized_line.write_bytes(b"{" + b"x" * take_cli.MAX_JSONL_LINE_BYTES + b"}\n")
    assert (
        take_cli.main(
            [
                "--telemetry",
                str(oversized_line),
                "--memory-board",
                str(board),
                "--safe-events",
                str(safe_events),
            ]
        )
        == 2
    )
    assert safe_events.exists() is False


def test_safe_event_output_race_uses_exclusive_create_and_never_overwrites(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "take.jsonl"
    board = tmp_path / "board.json"
    safe_events = tmp_path / "safe.jsonl"
    _write_jsonl(telemetry, passing_records())
    _write_board(board)
    original = take_cli.evaluate_codex_progress_recall

    def race(records: object, *, backend: str, board_refs: frozenset[str]) -> object:
        safe_events.write_text("RACE-WINNER\n", encoding="utf-8")
        return original(records, backend=backend, board_refs=board_refs)  # type: ignore[arg-type]

    monkeypatch.setattr(take_cli, "evaluate_codex_progress_recall", race)

    exit_code = take_cli.main(
        [
            "--telemetry",
            str(telemetry),
            "--memory-board",
            str(board),
            "--safe-events",
            str(safe_events),
        ]
    )

    assert exit_code == 2
    assert safe_events.read_text(encoding="utf-8") == "RACE-WINNER\n"
