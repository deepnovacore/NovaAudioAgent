from __future__ import annotations

import asyncio
import json
import platform
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from .artifacts import ArtifactWriter
from .cli import AttemptPolicy
from .evaluate import evaluate_phase_a, evaluate_six_gates
from .fixtures import AudioFixture, load_fixtures
from .interruption import (
    collect_smart_cancel_turn,
    execute_auto_cancel_baseline,
    execute_smart_cancel,
)
from .models import GateResult, HostState, ProbeEvent, ProbeReport
from .provider import ProviderError, RealtimeProvider
from .qwen import QWEN_ENDPOINT, QWEN_MODEL, QWEN_VOICE, QwenRealtimeProvider
from .runner import RealtimeProbeSession, ResponseCapture
from .scenario import FINAL_RESULT, build_scenario


@dataclass(slots=True)
class RunOutcome:
    report: ProbeReport
    events: list[ProbeEvent]
    raw_provider_events: list[dict[str, object]]
    audio: dict[str, bytes]


class PersistedOutcome(Protocol):
    report: ProbeReport
    events: list[ProbeEvent]
    raw_provider_events: list[dict[str, object]]
    audio: dict[str, bytes]


def _merge_usage(captures: Sequence[ResponseCapture]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for capture in captures:
        for key, value in (capture.usage or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                merged[key] = merged.get(key, 0) + value
    return merged


async def execute_phase_a(
    session: RealtimeProbeSession,
    fixture_pcm: Mapping[str, bytes],
    *,
    nonces: Sequence[str] | None = None,
) -> RunOutcome:
    nonce_values = list(nonces or [uuid4().hex for _ in range(3)])
    if len(nonce_values) != 3:
        raise ValueError("Phase A requires exactly three progress nonces")
    await session.connect(turn_detection=None)
    captures = [await session.request_delegate(fixture_pcm["delegate_request"], manual=True)]
    progress_steps = [step for step in build_scenario("phase-a") if step.kind == "progress"]
    for step, nonce in zip(progress_steps, nonce_values, strict=True):
        captures.append(await session.inject_progress(step, nonce=nonce))
    provenance = await session.send_audio_query(
        fixture_pcm["provenance_question"],
        purpose="provenance",
        manual=True,
    )
    captures.append(provenance)
    session.record_provenance_answer(provenance)
    gate = evaluate_phase_a(session.events)
    metrics = {
        "usage": _merge_usage(captures) or "unknown",
        "progress_to_spoken_ms": [
            transcript.t_ms - injected.t_ms
            for injected in session.events
            if injected.kind == "host.progress_injected"
            for transcript in session.events
            if transcript.kind == "assistant.transcript"
            and transcript.data.get("purpose") == "progress"
            and transcript.data.get("cause_event_id") == injected.data.get("progress_id")
        ],
        "chinese_speech_quality": "exploratory_synthetic_input_manual_review_required",
    }
    report = ProbeReport.for_run(
        provider="qwen",
        model=QWEN_MODEL,
        phase="phase-a",
        run_id=session.state.run_id,
        gates=[gate],
        metrics=metrics,
    )
    audio_names = ["delegate_ack", "progress_1", "progress_2", "progress_3", "provenance"]
    return RunOutcome(
        report=report,
        events=list(session.events),
        raw_provider_events=list(session.raw_provider_events),
        audio={name: capture.audio for name, capture in zip(audio_names, captures, strict=True)},
    )


def _invalid_report(*, phase: str, run_id: str, code: str) -> ProbeReport:
    gate = 4 if phase == "phase-a" else 0
    return ProbeReport.for_run(
        provider="qwen",
        model=QWEN_MODEL,
        phase=phase,
        run_id=run_id,
        gates=[GateResult(gate, "harness", "harness_invalid", [code])],
    )


def _fixture_bytes(fixtures: Mapping[str, AudioFixture]) -> dict[str, bytes]:
    return {name: fixture.path.read_bytes() for name, fixture in fixtures.items()}


async def _run_attempt(
    *,
    phase: str,
    arm: str | None,
    api_key: str,
    fixtures: Mapping[str, AudioFixture],
    pace_audio: bool = True,
) -> tuple[PersistedOutcome, RealtimeProbeSession]:
    run_id = f"run-{uuid4().hex[:16]}"
    state = HostState(run_id=run_id, delegate_id=f"delegate-{uuid4().hex[:16]}")
    provider = QwenRealtimeProvider(api_key=api_key)
    session = RealtimeProbeSession(provider=provider, state=state, pace_audio=pace_audio)
    outcome: PersistedOutcome | None = None
    failure: Exception | None = None
    try:
        if phase == "phase-a":
            outcome = await execute_phase_a(session, _fixture_bytes(fixtures))
        elif phase == "interruption":
            if arm == "auto-cancel-baseline":
                outcome = await execute_auto_cancel_baseline(session, _fixture_bytes(fixtures))
            else:
                outcome = await execute_smart_cancel(session, _fixture_bytes(fixtures))
        else:
            outcome = await execute_full(
                session,
                _fixture_bytes(fixtures),
                api_key=api_key,
                smart_cancel=arm == "smart-cancel",
            )
    except Exception as exc:
        failure = exc
    finally:
        try:
            await session.close()
        except Exception as exc:
            if outcome is None and failure is None:
                failure = exc
    if outcome is None:
        assert failure is not None
        code = failure.reason_code if isinstance(failure, ProviderError) else type(failure).__name__
        outcome = RunOutcome(
            report=_invalid_report(phase=phase, run_id=run_id, code=code),
            events=list(session.events),
            raw_provider_events=list(session.raw_provider_events),
            audio={},
        )
    return outcome, session


async def execute_full(
    session: RealtimeProbeSession,
    fixture_pcm: Mapping[str, bytes],
    *,
    api_key: str,
    reconnect_provider_factory: Callable[[], RealtimeProvider] | None = None,
    smart_cancel: bool = False,
) -> RunOutcome:
    await session.connect(turn_detection={"type": "smart_turn"})
    captures: list[ResponseCapture] = [
        await session.request_delegate(fixture_pcm["delegate_request"], manual=False)
    ]
    progress_steps = [step for step in build_scenario("full") if step.kind == "progress"]

    smart_cancel_metrics: dict[str, int | str] = {}
    if smart_cancel:
        interrupted_turn = await collect_smart_cancel_turn(
            session,
            progress_step=progress_steps[0],
            barge_pcm=fixture_pcm["barge_in"],
            nonce=uuid4().hex,
        )
        captures.extend([interrupted_turn.progress, interrupted_turn.foreground])
        smart_cancel_metrics = interrupted_turn.metrics
    else:
        await session.start_progress(progress_steps[0], nonce=uuid4().hex)
        foreground = await session.collect_barge_in(fixture_pcm["barge_in"])
        if session.last_barge_progress is None:
            raise ProviderError("barge-in progress capture is missing")
        captures.extend([session.last_barge_progress, foreground])
    captures.append(await session.inject_progress(progress_steps[1], nonce=uuid4().hex))

    session.record_connection_dropped()
    await session.close()

    reconnect_provider = (
        reconnect_provider_factory()
        if reconnect_provider_factory is not None
        else QwenRealtimeProvider(api_key=api_key)
    )
    recovered = RealtimeProbeSession(
        provider=reconnect_provider,
        state=session.state,
        pace_audio=session._pace_audio,
    )
    try:
        await recovered.connect(turn_detection={"type": "smart_turn"})
        await recovered.inject_recovery_snapshot()
        captures.append(
            await recovered.send_audio_query(
                fixture_pcm["recovery_question"], purpose="recovery", manual=False
            )
        )
        captures.append(await recovered.inject_progress(progress_steps[2], nonce=uuid4().hex))
        captures.append(await recovered.inject_final(final_id="final-1", result=FINAL_RESULT))
        captures.append(
            await recovered.send_audio_query(
                fixture_pcm["context_followup"], purpose="context_followup", manual=False
            )
        )

        first_events = list(session.events)
        offset = (first_events[-1].t_ms + 1) if first_events else 0
        combined_events = list(first_events)
        for event in recovered.events:
            combined_events.append(replace(event, t_ms=event.t_ms + offset))
        combined_events = [
            replace(event, event_ref=f"e{index:04d}")
            for index, event in enumerate(combined_events, start=1)
        ]
        gates = evaluate_six_gates(
            combined_events,
            strict_interruption=smart_cancel,
        )

        barge_sends = [event for event in combined_events if event.kind == "host.barge_in_sent"]
        cancellations = [
            event for event in combined_events if event.kind == "provider.response_cancelled"
        ]
        metrics = {
            "usage": _merge_usage(captures) or "unknown",
            "barge_in_effect_ms": (
                cancellations[0].t_ms - barge_sends[0].t_ms
                if barge_sends and cancellations
                else "unknown"
            ),
            "chinese_speech_quality": "exploratory_synthetic_input_manual_review_required",
            **smart_cancel_metrics,
        }
        report = ProbeReport.for_run(
            provider="qwen",
            model=QWEN_MODEL,
            phase="full",
            run_id=session.state.run_id,
            gates=gates,
            metrics=metrics,
        )
        audio_names = [
            "delegate_ack",
            "progress_1_interrupted",
            "foreground_barge_in",
            "progress_2",
            "recovery",
            "progress_3",
            "final",
            "context_followup",
        ]
        outcome = RunOutcome(
            report=report,
            events=combined_events,
            raw_provider_events=[
                *session.raw_provider_events,
                *recovered.raw_provider_events,
            ],
            audio={
                name: capture.audio for name, capture in zip(audio_names, captures, strict=True)
            },
        )
    except BaseException:
        try:
            await recovered.close()
        except Exception:
            pass
        raise
    try:
        await recovered.close()
    except Exception:
        pass
    return outcome


def _persist_attempt(
    *,
    writer: ArtifactWriter,
    outcome: PersistedOutcome,
    session: RealtimeProbeSession,
    fixtures: Mapping[str, AudioFixture],
    attempt: int,
    arm: str | None,
) -> None:
    provider_ids = {
        key: sorted({value for event in outcome.events if (value := event.provider.get(key, ""))})
        for key in ("session_id", "response_id", "item_id", "call_id")
    }
    manifest = {
        "schema_version": outcome.report.schema_version,
        "script_version": outcome.report.schema_version,
        "attempt": attempt,
        "provider": "qwen",
        "model": QWEN_MODEL,
        "voice": QWEN_VOICE,
        "endpoint_host": urlsplit(QWEN_ENDPOINT).hostname,
        "run_id": outcome.report.run_id,
        "delegate_id": session.state.delegate_id,
        "session_ids": sorted(
            {
                event.provider.get("session_id", "")
                for event in outcome.events
                if event.provider.get("session_id")
            }
        ),
        "provider_ids": provider_ids,
        "fixture_hashes": {name: fixture.sha256 for name, fixture in fixtures.items()},
        "started_at": datetime.now(timezone.utc).isoformat(),
        "clock": {"type": "monotonic", "unit": "milliseconds"},
        "platform": platform.platform(),
        "errors": sorted({reason for gate in outcome.report.gates for reason in gate.reason_codes}),
        "usage": outcome.report.metrics.get("usage", "unknown"),
    }
    if arm is not None:
        manifest["arm"] = arm
    if outcome.report.phase == "full" and arm == "smart-cancel":
        manifest["experiment_id"] = "qwen-full-smart-cancel.v1"
    elif outcome.report.phase == "interruption" and arm == "auto-cancel-baseline":
        manifest["experiment_id"] = "qwen-auto-cancel-baseline.v1"
    writer.write_manifest(manifest)
    writer.write_provider_events(outcome.raw_provider_events)
    writer.write_trajectory(outcome.events)
    writer.write_report(outcome.report)
    for name, fixture in fixtures.items():
        writer.write_input_fixture(name, fixture.path.read_bytes())
    for name, pcm in outcome.audio.items():
        writer.write_audio(name, pcm)


async def _run_live(args: Any, api_key: str, *, pace_audio: bool = True) -> int:
    if args.phase == "phase-a" and args.runs != 3:
        print("Phase A requires --runs 3", file=sys.stderr)
        return 2
    if args.phase == "full" and args.runs != 1:
        print("The full probe requires --runs 1", file=sys.stderr)
        return 2
    if args.phase == "interruption" and args.runs != 1:
        print("The interruption probe requires --runs 1", file=sys.stderr)
        return 2
    fixtures = load_fixtures(args.fixture_dir)
    stamp = f"{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}-{uuid4().hex[:8]}"
    root_name = f"{stamp}-qwen-{args.phase}"
    if args.arm is not None:
        root_name = f"{root_name}-{args.arm}"
    root = args.output / root_name
    policy = (
        AttemptPolicy(required_valid=3, max_attempts=6)
        if args.phase == "phase-a"
        else AttemptPolicy(required_valid=1, max_attempts=3)
    )
    decision = "continue"
    while decision == "continue":
        attempt = policy.attempts + 1
        outcome, session = await _run_attempt(
            phase=args.phase,
            arm=args.arm,
            api_key=api_key,
            fixtures=fixtures,
            pace_audio=pace_audio,
        )
        attempt_writer = ArtifactWriter(root / f"attempt-{attempt:02d}")
        _persist_attempt(
            writer=attempt_writer,
            outcome=outcome,
            session=session,
            fixtures=fixtures,
            attempt=attempt,
            arm=args.arm,
        )
        print(f"attempt={attempt} status={outcome.report.status} path={attempt_writer.root}")
        decision = policy.observe(outcome.report.status)
    summary = {
        "schema_version": "realtime-probe.v1",
        "provider": "qwen",
        "phase": args.phase,
        "decision": decision,
        "attempts": policy.attempts,
        "valid_passes": policy.valid_passes,
        "human_review_required": decision == "succeeded",
    }
    if args.arm is not None:
        summary["arm"] = args.arm
    if args.phase == "full" and args.arm == "smart-cancel":
        summary["experiment_id"] = "qwen-full-smart-cancel.v1"
    elif args.phase == "interruption" and args.arm == "auto-cancel-baseline":
        summary["experiment_id"] = "qwen-auto-cancel-baseline.v1"
    (root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if decision == "succeeded" else 1 if decision == "failed" else 2


def run_live_command(args: Any, api_key: str) -> int:
    if not api_key:
        print(
            "Missing DASHSCOPE_API_KEY or NOVA_AUDIO_AGENT_MODEL_API_KEY; no provider call was made.",
            file=sys.stderr,
        )
        return 2
    if args.phase == "history-recovery":
        from .history_recovery import run_history_recovery_probe

        return asyncio.run(
            run_history_recovery_probe(
                api_key=api_key,
                arm=args.arm,
                pair_budget=args.pairs,
                fixture_dir=args.fixture_dir,
                output=args.output,
            )
        )
    return asyncio.run(_run_live(args, api_key))
