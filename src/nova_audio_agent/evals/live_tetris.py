"""Text-only live Tetris acceptance driver and sanitized evaluation recorder."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Protocol

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.events import Event, HandoffEvent, ModelDone, ProgressEvent, UserInput
from nova_audio_agent.evals.tetris_artifact import TetrisArtifactReport, check_tetris_artifact
from nova_audio_agent.evals.trajectory import (
    TrajectoryFinding,
    TrajectoryReport,
    build_judge_view,
    evaluate_same_turn_trajectory,
    validate_judge_output,
)
from nova_audio_agent.ports import DispatchContext, ExecutorAdapter, Handoff, ProgressPayload
from nova_audio_agent.speech import SpeechSink

INITIAL_REQUEST = "写一个可以在本地运行的俄罗斯方块。完成后请告诉我怎么启动。"
STEERING_REQUEST = "再加一个要求：提供 1 到 10 级的下落速度控制，而且游戏运行中切换后要立即生效。"
FOREGROUND_PROBE = "它还在做的时候，你能告诉我现在进行到哪了吗？"

_RECORD_FIELDS: dict[str, frozenset[str]] = {
    "user.input": frozenset({"purpose", "text"}),
    "runtime.user_applied": frozenset({"input_ref", "status"}),
    "fast_brain.model_done": frozenset({"status"}),
    "fast_brain.speak": frozenset({"cause_ref", "text"}),
    "fast_brain.tool.codex_run": frozenset({"delegate_id", "request_summary", "tool"}),
    "codex.turn_started": frozenset({"delegate_id", "correlation"}),
    "codex.progress": frozenset(
        {"delegate_id", "phase", "internal_activity", "correlation", "summary"}
    ),
    "fast_brain.tool.codex_steer": frozenset({"delegate_id", "target", "request_summary", "tool"}),
    "codex.steer_accepted": frozenset({"delegate_id", "correlation", "status"}),
    "codex.turn_completed": frozenset({"correlation", "outcome"}),
    "handoff": frozenset({"delegate_id", "op", "outcome", "summary"}),
    "artifact.gate": frozenset({"name", "passed"}),
}


class LiveRuntime(Protocol):
    def post(self, event: UserInput) -> object: ...

    async def serve(self, stop: asyncio.Event) -> None: ...


ArtifactChecker = Callable[[Path], TetrisArtifactReport]


class LiveTetrisFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        self.records: tuple[Mapping[str, Any], ...] = ()
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class JudgeConfig:
    provider: str
    model: str
    prompt_version: str


Judge = Callable[[Mapping[str, Any], JudgeConfig], Awaitable[Mapping[str, Any]]]


@dataclass(frozen=True, slots=True)
class JudgeReport:
    config: JudgeConfig
    verdict: str
    findings: tuple[TrajectoryFinding, ...]


@dataclass(frozen=True, slots=True)
class LiveTetrisReport:
    hard_pass: bool
    trajectory: TrajectoryReport
    artifact: TetrisArtifactReport
    records: tuple[Mapping[str, Any], ...]
    judge: JudgeReport | None = None

    def to_mapping(self) -> dict[str, Any]:
        return {
            "hard_pass": self.hard_pass,
            "trajectory": {
                "passed": self.trajectory.passed,
                "findings": [asdict(finding) for finding in self.trajectory.findings],
            },
            "artifact": {
                "passed": self.artifact.passed,
                "gates": [asdict(gate) for gate in self.artifact.gates],
            },
            "records": [dict(record) for record in self.records],
            "judge": (
                None
                if self.judge is None
                else {
                    "config": asdict(self.judge.config),
                    "verdict": self.judge.verdict,
                    "findings": [asdict(finding) for finding in self.judge.findings],
                }
            ),
        }


class EvaluationRecorder:
    """Store only the evaluation allowlist with synthetic, monotone references."""

    def __init__(self, clock: Clock | None = None) -> None:
        self._clock = clock or RealClock()
        self._started = self._clock.now()
        self._records: list[dict[str, Any]] = []
        self._changed = asyncio.Event()

    @property
    def records(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(self._records)

    def now(self) -> float:
        return self._clock.now()

    def record(self, kind: str, actor: str, data: Mapping[str, Any]) -> dict[str, Any]:
        allowed = _RECORD_FIELDS.get(kind)
        if allowed is None:
            raise ValueError("unsupported evaluation event")
        sanitized = {key: data[key] for key in allowed if key in data and _safe_scalar(data[key])}
        record = {
            "event_ref": f"e{len(self._records) + 1:03d}",
            "t_ms": max(0.0, (self.now() - self._started) * 1000.0),
            "actor": actor,
            "kind": kind,
            "judge_visibility": "include",
            "data": sanitized,
        }
        self._records.append(record)
        self._changed.set()
        return record

    async def wait_for(
        self,
        kind: str,
        predicate: Callable[[Mapping[str, Any]], bool] | None = None,
        *,
        timeout: float,
        after_event_ref: str | None = None,
    ) -> Mapping[str, Any]:
        async def wait() -> Mapping[str, Any]:
            while True:
                self._changed.clear()
                after_seen = after_event_ref is None
                for record in self._records:
                    if not after_seen:
                        if record["event_ref"] == after_event_ref:
                            after_seen = True
                        continue
                    if record["kind"] != kind:
                        continue
                    if predicate is None or predicate(record):
                        return record
                await self._changed.wait()

        try:
            async with asyncio.timeout(timeout):
                return await wait()
        except TimeoutError:
            raise LiveTetrisFailure(f"live_tetris_timeout:{kind}") from None


class RecordingCodexAdapter:
    """Record transport attestations without retaining private thread or turn IDs.

    The wrapped transport only emits ``started`` after its active thread/turn pair
    has matched, and only returns ``accepted`` after the steer response repeats the
    active turn ID.  The recorder preserves those verified facts instead of
    fabricating placeholder identifiers that merely compare equal to themselves.
    """

    def __init__(self, inner: ExecutorAdapter, recorder: EvaluationRecorder) -> None:
        self._inner = inner
        self._recorder = recorder
        self.manifest = inner.manifest
        self._run_delegate: str | None = None
        self._turn_started = False

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op == "run":
            self._run_delegate = ctx.delegate.delegate_id
            self._recorder.record(
                "fast_brain.tool.codex_run",
                "fast_brain",
                {
                    "delegate_id": ctx.delegate.delegate_id,
                    "request_summary": "contracted tetris implementation",
                    "tool": "codex.run",
                },
            )

            def progress(payload: ProgressPayload) -> None:
                if payload.phase == "started" and not self._turn_started:
                    self._turn_started = True
                    self._recorder.record(
                        "codex.turn_started",
                        "codex_transport",
                        {
                            "delegate_id": ctx.delegate.delegate_id,
                            "correlation": "active_pair_verified",
                        },
                    )
                data: dict[str, Any] = {
                    "delegate_id": ctx.delegate.delegate_id,
                    "correlation": "active_pair_verified",
                    "phase": payload.phase,
                    "internal_activity": payload.internal_activity,
                }
                if payload.summary is not None:
                    data["summary"] = payload.summary
                self._recorder.record("codex.progress", "codex_transport", data)
                if ctx.progress is not None:
                    ctx.progress(payload)

            result = await self._inner.dispatch(op, request, replace(ctx, progress=progress))
            if self._turn_started:
                self._recorder.record(
                    "codex.turn_completed",
                    "codex_transport",
                    {
                        "correlation": "active_pair_verified",
                        "outcome": result.outcome,
                    },
                )
            return result
        if op == "steer":
            self._recorder.record(
                "fast_brain.tool.codex_steer",
                "fast_brain",
                {
                    "delegate_id": ctx.delegate.delegate_id,
                    "target": "active_turn",
                    "request_summary": "runtime speed control",
                    "tool": "codex.steer",
                },
            )
            result = await self._inner.dispatch(op, request, ctx)
            if result.outcome == "ok" and result.content.get("code") == "accepted":
                self._recorder.record(
                    "codex.steer_accepted",
                    "codex_transport",
                    {
                        "delegate_id": ctx.delegate.delegate_id,
                        "correlation": "same_active_turn",
                        "status": "accepted",
                    },
                )
            return result
        return await self._inner.dispatch(op, request, ctx)


class CauseTracker:
    def __init__(self) -> None:
        self.current: str | None = None


class EvaluationSpeechSink:
    """Forward speech while recording one bounded event per completed utterance."""

    def __init__(
        self,
        inner: SpeechSink,
        recorder: EvaluationRecorder,
        causes: CauseTracker,
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._causes = causes
        self._chunks: dict[str, list[str]] = {}
        self._utterance_causes: dict[str, str | None] = {}

    def emit(self, utterance_id: str, text: str) -> None:
        self._inner.emit(utterance_id, text)
        self._chunks.setdefault(utterance_id, []).append(text)
        self._utterance_causes.setdefault(utterance_id, self._causes.current)

    def end(self, utterance_id: str) -> None:
        self._inner.end(utterance_id)
        text = " ".join("".join(self._chunks.pop(utterance_id, ())).split())[:4000]
        cause = self._utterance_causes.pop(utterance_id, None)
        if text and cause is not None:
            self._recorder.record(
                "fast_brain.speak",
                "fast_brain",
                {"cause_ref": cause, "text": text},
            )


def runtime_observer(
    recorder: EvaluationRecorder,
    causes: CauseTracker,
) -> Callable[[Event], None]:
    """Return a read-only observer that adds no runtime effects."""

    def observe(event: Event) -> None:
        if isinstance(event, UserInput):
            for record in reversed(recorder.records):
                if record["kind"] == "user.input" and record["data"].get("text") == event.text:
                    causes.current = str(record["event_ref"])
                    recorder.record(
                        "runtime.user_applied",
                        "runtime",
                        {"input_ref": causes.current, "status": "applied"},
                    )
                    return
        if isinstance(event, ModelDone) and event.slot == "fast":
            recorder.record(
                "fast_brain.model_done",
                "runtime",
                {"status": "completed"},
            )
            return
        if isinstance(event, ProgressEvent):
            for record in reversed(recorder.records):
                if (
                    record["kind"] == "codex.progress"
                    and record["data"].get("phase") == event.phase
                    and record["data"].get("internal_activity") == event.internal_activity
                ):
                    causes.current = str(record["event_ref"])
                    return
        if isinstance(event, HandoffEvent) and event.channel == "codex":
            accepted = event.content.get("code") == "accepted"
            op = event.content.get("op")
            safe_op = op if op in {"run", "steer", "status"} else "unknown"
            summary = (
                "steering accepted"
                if accepted
                else "status snapshot"
                if safe_op == "status"
                else "codex run completed"
                if safe_op == "run"
                else "codex handoff"
            )
            record = recorder.record(
                "handoff",
                "runtime",
                {
                    "delegate_id": event.delegate_id,
                    "op": safe_op,
                    "outcome": "accepted" if accepted else event.outcome,
                    "summary": summary,
                },
            )
            causes.current = str(record["event_ref"])

    return observe


class LiveTetrisDriver:
    """Act only as the user; observable recorder events decide every transition."""

    def __init__(
        self,
        *,
        runtime: LiveRuntime,
        recorder: EvaluationRecorder,
        workspace: Path,
        artifact_checker: ArtifactChecker = check_tetris_artifact,
        timeout: float = 600.0,
        judge: Judge | None = None,
        judge_config: JudgeConfig | None = None,
    ) -> None:
        self._runtime = runtime
        self._recorder = recorder
        self._workspace = workspace
        self._artifact_checker = artifact_checker
        self._timeout = timeout
        self._judge = judge
        self._judge_config = judge_config

    async def run(self) -> LiveTetrisReport:
        stop = asyncio.Event()
        serving = asyncio.create_task(self._runtime.serve(stop))
        deadline = self._recorder.now() + self._timeout
        try:
            initial = self._submit("task", INITIAL_REQUEST)
            await self._recorder.wait_for(
                "fast_brain.speak",
                lambda record: record["data"].get("cause_ref") == initial["event_ref"],
                timeout=self._remaining(deadline),
            )
            run_record = await self._recorder.wait_for(
                "fast_brain.tool.codex_run", timeout=self._remaining(deadline)
            )
            run_delegate = self._delegate_id(run_record, "run")
            await self._recorder.wait_for("codex.turn_started", timeout=self._remaining(deadline))
            await self._recorder.wait_for(
                "codex.progress",
                lambda record: (
                    record["data"].get("phase") == "started"
                    and record["data"].get("internal_activity") == 0
                ),
                timeout=self._remaining(deadline),
            )

            self._submit("steer", STEERING_REQUEST)
            steer_record = await self._recorder.wait_for(
                "fast_brain.tool.codex_steer", timeout=self._remaining(deadline)
            )
            steer_delegate = self._delegate_id(steer_record, "steer")
            await self._recorder.wait_for(
                "codex.steer_accepted",
                lambda record: record["data"].get("delegate_id") == steer_delegate,
                timeout=self._remaining(deadline),
            )
            await self._recorder.wait_for(
                "handoff",
                lambda record: (
                    record["data"].get("outcome") == "accepted"
                    and record["data"].get("delegate_id") == steer_delegate
                ),
                timeout=self._remaining(deadline),
            )

            foreground = self._submit("foreground", FOREGROUND_PROBE)
            await self._recorder.wait_for(
                "fast_brain.speak",
                lambda record: record["data"].get("cause_ref") == foreground["event_ref"],
                timeout=self._remaining(deadline),
            )
            await self._recorder.wait_for(
                "codex.progress",
                lambda record: record["data"].get("phase") == "working",
                timeout=self._remaining(deadline),
                after_event_ref=str(foreground["event_ref"]),
            )
            await self._recorder.wait_for("codex.turn_completed", timeout=self._remaining(deadline))
            run_handoff = await self._recorder.wait_for(
                "handoff",
                lambda record: (
                    record["data"].get("outcome") == "ok"
                    and record["data"].get("delegate_id") == run_delegate
                ),
                timeout=self._remaining(deadline),
            )
            await self._recorder.wait_for(
                "fast_brain.speak",
                lambda record: record["data"].get("cause_ref") == run_handoff["event_ref"],
                timeout=self._remaining(deadline),
            )
        finally:
            stop.set()
            try:
                await serving
            except asyncio.CancelledError:
                raise

        artifact = await asyncio.to_thread(self._artifact_checker, self._workspace)
        for gate in artifact.gates:
            self._recorder.record(
                "artifact.gate",
                "artifact_checker",
                {"name": gate.name, "passed": gate.passed},
            )
        trajectory = evaluate_same_turn_trajectory(self._recorder.records)
        judge_report = await self._run_judge()
        return LiveTetrisReport(
            hard_pass=artifact.passed and trajectory.passed,
            trajectory=trajectory,
            artifact=artifact,
            records=self._recorder.records,
            judge=judge_report,
        )

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._recorder.now()
        if remaining <= 0:
            raise LiveTetrisFailure("live_tetris_timeout:scenario")
        return remaining

    @staticmethod
    def _delegate_id(record: Mapping[str, Any], operation: str) -> str:
        delegate_id = record.get("data", {}).get("delegate_id")
        if type(delegate_id) is not str or not delegate_id:
            raise LiveTetrisFailure(f"live_tetris_invalid_delegate:{operation}")
        return delegate_id

    def _submit(self, purpose: str, text: str) -> Mapping[str, Any]:
        record = self._recorder.record("user.input", "user", {"purpose": purpose, "text": text})
        self._runtime.post(UserInput(text=text))
        return record

    async def _run_judge(self) -> JudgeReport | None:
        if self._judge is None:
            return None
        config = self._judge_config
        if config is None:
            config = JudgeConfig(provider="unknown", model="unknown", prompt_version="unknown")
        try:
            output = await self._judge(build_judge_view(self._recorder.records), config)
            raw_findings = validate_judge_output(output, build_judge_view(self._recorder.records))
            findings = tuple(
                TrajectoryFinding(
                    code=finding.code,
                    event_ref=None,
                    detail="judge output failed bounded validation",
                )
                for finding in raw_findings
            )
            verdict = output.get("verdict") if type(output) is dict else None
            safe_verdict = verdict if verdict in {"pass", "finding"} else "invalid"
            if safe_verdict == "finding":
                findings = (
                    *findings,
                    TrajectoryFinding(
                        code="judge_negative_verdict",
                        event_ref=None,
                        detail="interaction judge reported a soft finding",
                    ),
                )
            return JudgeReport(config=config, verdict=safe_verdict, findings=findings)
        except Exception:
            return JudgeReport(
                config=config,
                verdict="unavailable",
                findings=(
                    TrajectoryFinding(
                        code="judge_unavailable",
                        event_ref=None,
                        detail="interaction judge was unavailable",
                    ),
                ),
            )


def _safe_scalar(value: object) -> bool:
    if type(value) is str:
        return len(value) <= 4000 and all(char.isprintable() for char in value)
    if type(value) is bool:
        return True
    if type(value) is int:
        return 0 <= value <= 1_048_576
    if type(value) is float:
        return math.isfinite(value) and value >= 0
    return False
