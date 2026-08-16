from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from nova_audio_agent.events import HandoffEvent, UserInput
from nova_audio_agent.evals.live_tetris import (
    CauseTracker,
    FOREGROUND_PROBE,
    INITIAL_REQUEST,
    STEERING_REQUEST,
    EvaluationRecorder,
    EvaluationSpeechSink,
    JudgeConfig,
    LiveTetrisFailure,
    LiveTetrisDriver,
    RecordingCodexAdapter,
    runtime_observer,
)
from nova_audio_agent.evals.tetris_artifact import ArtifactGate, TetrisArtifactReport
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import RUN
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST
from nova_audio_agent.ports import (
    DelegateRequest,
    DispatchContext,
    Handoff,
    ProgressPayload,
    bind_delegate,
)
from nova_audio_agent.speech import RecordingSink


class _Runtime:
    def __init__(self, recorder: EvaluationRecorder) -> None:
        self.recorder = recorder
        self.posts: list[UserInput] = []

    def post(self, event: UserInput) -> UserInput:
        assert type(event) is UserInput
        self.posts.append(event)
        if event.text == INITIAL_REQUEST:
            asyncio.create_task(self._initial())
        elif event.text == STEERING_REQUEST:
            asyncio.create_task(self._steer())
        elif event.text == FOREGROUND_PROBE:
            asyncio.create_task(self._foreground_and_complete())
        return event

    async def serve(self, stop: asyncio.Event) -> None:
        await stop.wait()

    async def _initial(self) -> None:
        await asyncio.sleep(0)
        self.recorder.record(
            "fast_brain.speak", "fast_brain", {"cause_ref": "e001", "text": "已开始。"}
        )
        self.recorder.record(
            "fast_brain.tool.codex_run",
            "fast_brain",
            {"delegate_id": "d-run", "request_summary": "contracted tetris", "tool": "codex.run"},
        )
        self.recorder.record(
            "codex.turn_started",
            "codex_transport",
            {"delegate_id": "d-run", "correlation": "active_pair_verified"},
        )
        self.recorder.record(
            "codex.progress",
            "codex_transport",
            {
                "delegate_id": "d-run",
                "correlation": "active_pair_verified",
                "phase": "started",
                "internal_activity": 0,
            },
        )

    async def _steer(self) -> None:
        await asyncio.sleep(0)
        self.recorder.record(
            "fast_brain.speak", "fast_brain", {"cause_ref": "e006", "text": "已补充要求。"}
        )
        self.recorder.record(
            "fast_brain.tool.codex_steer",
            "fast_brain",
            {
                "delegate_id": "d-steer",
                "target": "active_turn",
                "request_summary": "runtime speed control",
                "tool": "codex.steer",
            },
        )
        self.recorder.record(
            "codex.steer_accepted",
            "codex_transport",
            {
                "delegate_id": "d-steer",
                "correlation": "same_active_turn",
                "status": "accepted",
            },
        )
        self.recorder.record(
            "handoff",
            "runtime",
            {"delegate_id": "d-steer", "outcome": "accepted", "summary": "accepted"},
        )

    async def _foreground_and_complete(self) -> None:
        await asyncio.sleep(0)
        self.recorder.record(
            "fast_brain.speak", "fast_brain", {"cause_ref": "e011", "text": "仍在进行。"}
        )
        self.recorder.record(
            "codex.progress",
            "codex_transport",
            {
                "delegate_id": "d-run",
                "correlation": "active_pair_verified",
                "phase": "working",
                "internal_activity": 2,
            },
        )
        self.recorder.record(
            "handoff",
            "runtime",
            {"delegate_id": "d-status", "outcome": "ok", "summary": "status snapshot"},
        )
        self.recorder.record(
            "codex.turn_completed",
            "codex_transport",
            {"correlation": "active_pair_verified", "outcome": "ok"},
        )
        handoff = self.recorder.record(
            "handoff",
            "runtime",
            {"delegate_id": "d-run", "outcome": "ok", "summary": "complete"},
        )
        self.recorder.record(
            "fast_brain.speak",
            "fast_brain",
            {"cause_ref": handoff["event_ref"], "text": "已经完成。"},
        )


def _artifact(_workspace: Path) -> TetrisArtifactReport:
    return TetrisArtifactReport(
        gates=(
            ArtifactGate("build_and_start", True),
            ArtifactGate("core_tetris_behavior", True),
            ArtifactGate("steered_speed_control", True),
            ArtifactGate("workspace_hygiene", True),
        )
    )


async def test_live_driver_submits_only_user_input_and_hard_gates_pass(tmp_path: Path) -> None:
    recorder = EvaluationRecorder()
    runtime = _Runtime(recorder)
    driver = LiveTetrisDriver(
        runtime=runtime,
        recorder=recorder,
        workspace=tmp_path,
        artifact_checker=_artifact,
        timeout=1.0,
    )

    report = await driver.run()

    assert [event.text for event in runtime.posts] == [
        INITIAL_REQUEST,
        STEERING_REQUEST,
        FOREGROUND_PROBE,
    ]
    assert all(type(event) is UserInput for event in runtime.posts)
    assert report.hard_pass is True
    assert report.trajectory.passed is True
    assert report.judge is None


@pytest.mark.real_time
async def test_live_driver_reports_the_exact_timed_out_gate(tmp_path: Path) -> None:
    recorder = EvaluationRecorder()

    class _SilentRuntime:
        def post(self, event):
            return event

        async def serve(self, stop):
            await stop.wait()

    driver = LiveTetrisDriver(
        runtime=_SilentRuntime(),
        recorder=recorder,
        workspace=tmp_path,
        artifact_checker=_artifact,
        timeout=0.01,
    )

    with pytest.raises(LiveTetrisFailure) as caught:
        await driver.run()

    assert caught.value.code == "live_tetris_timeout:fast_brain.speak"


@pytest.mark.real_time
async def test_foreground_probe_requires_new_working_progress(tmp_path: Path) -> None:
    recorder = EvaluationRecorder()

    class _OnlyEarlierWorkingRuntime(_Runtime):
        async def _initial(self) -> None:
            await super()._initial()
            self.recorder.record(
                "codex.progress",
                "codex_transport",
                {
                    "delegate_id": "d-run",
                    "correlation": "active_pair_verified",
                    "phase": "working",
                    "internal_activity": 1,
                },
            )

        async def _foreground_and_complete(self) -> None:
            await asyncio.sleep(0)
            self.recorder.record(
                "fast_brain.speak",
                "fast_brain",
                {"cause_ref": "e012", "text": "仍在进行。"},
            )

    driver = LiveTetrisDriver(
        runtime=_OnlyEarlierWorkingRuntime(recorder),
        recorder=recorder,
        workspace=tmp_path,
        artifact_checker=_artifact,
        timeout=0.02,
    )

    with pytest.raises(LiveTetrisFailure) as caught:
        await driver.run()

    assert caught.value.code == "live_tetris_timeout:codex.progress"


async def test_negative_or_invalid_judge_is_soft_only(tmp_path: Path) -> None:
    recorder = EvaluationRecorder()
    runtime = _Runtime(recorder)

    async def judge(_view, _config):
        return {
            "verdict": "finding",
            "scores": {"responsiveness": 1},
            "evidence_refs": ["missing-private-event"],
            "summary": "needs improvement",
        }

    report = await LiveTetrisDriver(
        runtime=runtime,
        recorder=recorder,
        workspace=tmp_path,
        artifact_checker=_artifact,
        timeout=1.0,
        judge=judge,
        judge_config=JudgeConfig(provider="test", model="judge", prompt_version="v1"),
    ).run()

    assert report.hard_pass is True
    assert report.judge is not None
    assert report.judge.verdict == "finding"
    assert "judge_unknown_evidence_ref" in {finding.code for finding in report.judge.findings}
    encoded = json.dumps(report.to_mapping(), ensure_ascii=False)
    assert report.judge.config == JudgeConfig(provider="test", model="judge", prompt_version="v1")
    assert "missing-private-event" not in encoded


async def test_recording_adapter_drops_sensitive_requests_and_handoff_payloads() -> None:
    sentinel = "TOP-SECRET-WORK-ORDER-SENTINEL"
    recorder = EvaluationRecorder()

    class _Adapter:
        manifest = CODEX_LIVE_MANIFEST

        async def dispatch(self, op, request, ctx):
            assert sentinel in json.dumps(request)
            assert ctx.progress is not None
            ctx.progress(ProgressPayload(phase="started", internal_activity=0, elapsed=0.0))
            return Handoff(
                outcome="ok",
                trust="untrusted_external",
                content={"private": sentinel, "code": "completed"},
            )

    clock = VirtualClock()
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={"work_order": sentinel},
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
        op=RUN,
        now=0.0,
        delegate_id="d-run",
    )
    progress: list[ProgressPayload] = []

    await RecordingCodexAdapter(_Adapter(), recorder).dispatch(
        "run",
        {"work_order": sentinel},
        DispatchContext(clock=clock, delegate=delegate, progress=progress.append),
    )

    assert progress == [ProgressPayload(phase="started", internal_activity=0, elapsed=0.0)]
    assert sentinel not in json.dumps(recorder.records)


def test_evaluation_speech_normalizes_multiline_text_instead_of_recording_empty_event() -> None:
    clock = VirtualClock()
    recorder = EvaluationRecorder(clock)
    causes = CauseTracker()
    causes.current = "e001"
    sink = EvaluationSpeechSink(RecordingSink(clock), recorder, causes)

    sink.emit("u-1", "第一行\n")
    sink.emit("u-1", "第二行")
    sink.end("u-1")

    assert recorder.records == (
        {
            "event_ref": "e001",
            "t_ms": 0.0,
            "actor": "fast_brain",
            "kind": "fast_brain.speak",
            "judge_visibility": "include",
            "data": {"cause_ref": "e001", "text": "第一行 第二行"},
        },
    )


def test_runtime_observer_labels_status_handoff_as_snapshot_not_run_completion() -> None:
    recorder = EvaluationRecorder(VirtualClock())
    causes = CauseTracker()
    observe = runtime_observer(recorder, causes)

    observe(
        HandoffEvent(
            channel="codex",
            delegate_id="d-status",
            origin_ref="conversation:1",
            outcome="ok",
            trust="trusted_system",
            content={"op": "status", "state": "running"},
        )
    )

    assert recorder.records[0]["data"] == {
        "delegate_id": "d-status",
        "op": "status",
        "outcome": "ok",
        "summary": "status snapshot",
    }
