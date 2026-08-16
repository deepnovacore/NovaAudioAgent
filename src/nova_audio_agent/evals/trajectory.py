"""Minimal, offline checks for a GPT-Live FastBrain/Codex trajectory.

This module is deliberately smaller than the proposed live evaluation harness. It gives the
default pytest suite an executable contract without starting Codex, calling a model, or spending
API tokens. The ordinary runtime trace remains unchanged and keeps its stricter hygiene boundary.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from nova_audio_agent.ports import valid_progress_summary


_PROGRESS_FIELDS = frozenset(
    {"delegate_id", "phase", "internal_activity", "correlation", "summary"}
)
_REQUIRED_ARTIFACT_GATES = frozenset(
    {"build_and_start", "core_tetris_behavior", "steered_speed_control", "workspace_hygiene"}
)
_JUDGE_FIELDS: dict[str, frozenset[str]] = {
    "user.input": frozenset({"purpose", "text"}),
    "fast_brain.speak": frozenset({"cause_ref", "text"}),
    "fast_brain.tool.codex_run": frozenset({"delegate_id", "request_summary", "tool"}),
    "codex.turn_started": frozenset({"delegate_id"}),
    "codex.progress": frozenset({"internal_activity", "phase"}),
    "fast_brain.tool.codex_steer": frozenset({"delegate_id", "request_summary", "tool"}),
    "codex.steer_accepted": frozenset({"delegate_id", "status"}),
    "codex.turn_completed": frozenset({"outcome"}),
    "handoff": frozenset({"delegate_id", "op", "outcome", "summary"}),
    "artifact.gate": frozenset({"name", "passed"}),
}


@dataclass(frozen=True, slots=True)
class TrajectoryFinding:
    code: str
    event_ref: str | None
    detail: str


@dataclass(frozen=True, slots=True)
class TrajectoryReport:
    findings: tuple[TrajectoryFinding, ...]

    @property
    def passed(self) -> bool:
        return not self.findings


def _finding(code: str, record: Mapping[str, Any] | None, detail: str) -> TrajectoryFinding:
    event_ref = record.get("event_ref") if record is not None else None
    return TrajectoryFinding(
        code=code,
        event_ref=event_ref if isinstance(event_ref, str) else None,
        detail=detail,
    )


def _events(records: Sequence[Mapping[str, Any]], kind: str) -> list[tuple[int, Mapping[str, Any]]]:
    return [(index, record) for index, record in enumerate(records) if record.get("kind") == kind]


def _data(record: Mapping[str, Any]) -> Mapping[str, Any]:
    value = record.get("data")
    return value if isinstance(value, Mapping) else {}


def evaluate_same_turn_trajectory(
    records: Sequence[Mapping[str, Any]],
) -> TrajectoryReport:
    """Check the smallest deterministic contract needed by the Tetris research fixture."""
    items = list(records)
    findings: list[TrajectoryFinding] = []
    refs: set[str] = set()
    previous_t_ms = -1.0
    for record in items:
        event_ref = record.get("event_ref")
        if not isinstance(event_ref, str) or not event_ref:
            findings.append(_finding("invalid_event_ref", record, "event_ref must be non-empty"))
        elif event_ref in refs:
            findings.append(_finding("duplicate_event_ref", record, f"duplicate {event_ref}"))
        else:
            refs.add(event_ref)

        t_ms = record.get("t_ms")
        if isinstance(t_ms, bool) or not isinstance(t_ms, (int, float)) or t_ms < previous_t_ms:
            findings.append(
                _finding("invalid_event_time", record, "t_ms must be numeric and monotonic")
            )
        else:
            previous_t_ms = float(t_ms)

        if not isinstance(record.get("kind"), str) or not isinstance(record.get("data"), Mapping):
            findings.append(
                _finding("invalid_event_shape", record, "kind and mapping data are required")
            )

    runs = _events(items, "fast_brain.tool.codex_run")
    starts = _events(items, "codex.turn_started")
    steers = _events(items, "fast_brain.tool.codex_steer")
    accepts = _events(items, "codex.steer_accepted")
    completions = _events(items, "codex.turn_completed")
    if not all((runs, starts, steers, accepts, completions)):
        findings.append(
            _finding(
                "required_event_missing",
                None,
                "run, turn start, steer, steer acceptance, and completion are required",
            )
        )
        return TrajectoryReport(tuple(findings))
    if len(runs) != 1:
        findings.append(
            _finding(
                "unexpected_run_count",
                runs[1][1] if len(runs) > 1 else None,
                "the fixture must contain exactly one Codex run",
            )
        )
    if len(starts) != 1:
        findings.append(
            _finding(
                "unexpected_additional_turn",
                starts[1][1] if len(starts) > 1 else None,
                "the accepted steer must not create another turn",
            )
        )
    if len(steers) != 1:
        findings.append(
            _finding(
                "unexpected_steer_count",
                steers[1][1] if len(steers) > 1 else None,
                "the fixture must contain exactly one steering request",
            )
        )
    if len(accepts) != 1:
        findings.append(
            _finding(
                "unexpected_steer_acceptance_count",
                accepts[1][1] if len(accepts) > 1 else None,
                "the fixture must contain exactly one steering acceptance",
            )
        )
    if len(completions) != 1:
        findings.append(
            _finding(
                "unexpected_turn_completion_count",
                completions[1][1] if len(completions) > 1 else None,
                "the fixture must contain exactly one turn completion",
            )
        )

    run_index, run = runs[0]
    start_index, start = starts[0]
    steer_index, steer = steers[0]
    accept_index, accept = accepts[0]
    completion_index, completion = completions[0]
    run_data = _data(run)
    start_data = _data(start)
    steer_data = _data(steer)
    accept_data = _data(accept)
    completion_data = _data(completion)

    if not (run_index < start_index < steer_index <= accept_index < completion_index):
        findings.append(
            _finding(
                "invalid_steer_order",
                steer,
                "steer must be accepted after turn start and before turn completion",
            )
        )

    run_delegate = run_data.get("delegate_id")
    steer_delegate = steer_data.get("delegate_id")
    if (
        not isinstance(run_delegate, str)
        or not run_delegate
        or start_data.get("delegate_id") != run_delegate
        or start_data.get("correlation") != "active_pair_verified"
    ):
        findings.append(
            _finding(
                "turn_start_identity_mismatch",
                start,
                "turn start must be transport-correlated to the original run delegate",
            )
        )
    if not isinstance(steer_delegate, str) or not steer_delegate or steer_delegate == run_delegate:
        findings.append(
            _finding(
                "steer_delegate_invalid",
                steer,
                "steering needs a distinct non-empty delegate identity",
            )
        )
    if steer_data.get("target") != "active_turn":
        findings.append(
            _finding(
                "steer_turn_mismatch",
                steer,
                "steer must target the transport-owned active turn",
            )
        )
    if (
        accept_data.get("delegate_id") != steer_delegate
        or accept_data.get("correlation") != "same_active_turn"
    ):
        findings.append(
            _finding(
                "steer_acceptance_identity_mismatch",
                accept,
                "steer acceptance must be transport-verified against the active turn",
            )
        )
    if accept_data.get("status") != "accepted":
        findings.append(
            _finding(
                "steer_not_accepted",
                accept,
                "the steering request must be accepted into the active turn",
            )
        )
    if completion_data.get("correlation") != "active_pair_verified":
        findings.append(
            _finding(
                "turn_completion_identity_mismatch",
                completion,
                "turn completion must be transport-correlated to the active pair",
            )
        )
    if completion_data.get("outcome") != "ok":
        findings.append(
            _finding(
                "turn_completion_not_ok",
                completion,
                "the acceptance fixture requires a successful turn",
            )
        )

    steering_inputs = [
        entry for entry in _events(items, "user.input") if _data(entry[1]).get("purpose") == "steer"
    ]
    if not any(start_index < index < steer_index for index, _record in steering_inputs):
        findings.append(
            _finding(
                "steering_input_missing",
                steer,
                "a committed user correction must cause steering during the active turn",
            )
        )

    progress_events = _events(items, "codex.progress")
    started_progress = [
        entry for entry in progress_events if _data(entry[1]).get("phase") == "started"
    ]
    working_progress = [
        entry for entry in progress_events if _data(entry[1]).get("phase") == "working"
    ]
    if len(started_progress) != 1 or not working_progress:
        findings.append(
            _finding(
                "progress_sequence_missing",
                None,
                "the fixture needs one started milestone and at least one working milestone",
            )
        )

    started_progress_index = started_progress[0][0] if len(started_progress) == 1 else start_index
    previous_activity = 0
    for progress_index, progress in progress_events:
        data = _data(progress)
        if set(data) - _PROGRESS_FIELDS:
            findings.append(
                _finding(
                    "progress_payload_not_allowlisted",
                    progress,
                    "progress contains fields outside the metadata allowlist",
                )
            )
        if "summary" in data:
            summary = data["summary"]
            # CP1: the acceptance check enforces the full R103 shape, not just
            # the cap — the recorder sits upstream of the runtime validator.
            if not valid_progress_summary(summary, phase=str(data.get("phase"))):
                findings.append(
                    _finding(
                        "progress_summary_unbounded",
                        progress,
                        "progress summary must be bounded text",
                    )
                )
        if (
            data.get("delegate_id") != run_delegate
            or data.get("correlation") != "active_pair_verified"
        ):
            findings.append(
                _finding(
                    "progress_identity_mismatch",
                    progress,
                    "progress must remain owned by the original run delegate",
                )
            )
        phase = data.get("phase")
        activity = data.get("internal_activity")
        if phase == "started":
            if activity != 0 or not (start_index < progress_index < completion_index):
                findings.append(
                    _finding(
                        "progress_started_invalid",
                        progress,
                        "started progress must be in-turn with internal_activity=0",
                    )
                )
        elif phase == "working":
            if (
                isinstance(activity, bool)
                or not isinstance(activity, int)
                or activity <= previous_activity
                or progress_index <= started_progress_index
                or not (start_index < progress_index < completion_index)
            ):
                findings.append(
                    _finding(
                        "progress_not_advancing",
                        progress,
                        "working progress must be in-turn and increase internal activity",
                    )
                )
            else:
                previous_activity = activity
        else:
            findings.append(
                _finding(
                    "progress_phase_invalid",
                    progress,
                    "progress phase must be started or working",
                )
            )

    handoffs = _events(items, "handoff")
    steer_handoffs = [
        entry for entry in handoffs if _data(entry[1]).get("delegate_id") == steer_delegate
    ]
    run_handoffs = [
        entry for entry in handoffs if _data(entry[1]).get("delegate_id") == run_delegate
    ]
    if len(steer_handoffs) != 1 or _data(steer_handoffs[0][1]).get("outcome") != "accepted":
        findings.append(
            _finding(
                "steer_acceptance_handoff_missing",
                accept,
                "the steer delegate needs its own accepted handoff",
            )
        )
    elif not (accept_index < steer_handoffs[0][0] < completion_index):
        findings.append(
            _finding(
                "steer_handoff_order",
                steer_handoffs[0][1],
                "the steer handoff must follow acceptance and precede completion",
            )
        )
    if len(run_handoffs) != 1 or _data(run_handoffs[0][1]).get("outcome") != "ok":
        findings.append(
            _finding(
                "run_final_handoff_missing",
                completion,
                "the original run delegate must own the successful final handoff",
            )
        )
    elif run_handoffs[0][0] <= completion_index:
        findings.append(
            _finding(
                "run_handoff_order",
                run_handoffs[0][1],
                "the run handoff must follow matching turn completion",
            )
        )

    foreground = [
        entry
        for entry in _events(items, "user.input")
        if _data(entry[1]).get("purpose") == "foreground"
    ]
    if not foreground:
        findings.append(
            _finding("foreground_probe_missing", None, "the fixture needs an in-flight user turn")
        )
    else:
        in_flight_foreground = [
            entry for entry in foreground if start_index < entry[0] < completion_index
        ]
        if not in_flight_foreground:
            findings.append(
                _finding(
                    "foreground_probe_not_in_flight",
                    foreground[0][1],
                    "the foreground probe must occur while the Codex turn is active",
                )
            )
            in_flight_foreground = foreground
        foreground_index, foreground_event = in_flight_foreground[0]
        foreground_ref = foreground_event.get("event_ref")
        replies = [
            entry
            for entry in _events(items, "fast_brain.speak")
            if _data(entry[1]).get("cause_ref") == foreground_ref
        ]
        if not replies or not (foreground_index < replies[0][0] < completion_index):
            findings.append(
                _finding(
                    "foreground_response_missing",
                    foreground_event,
                    "FastBrain must answer while Codex is still working",
                )
            )

    if len(run_handoffs) == 1:
        run_handoff_index, run_handoff = run_handoffs[0]
        run_handoff_ref = run_handoff.get("event_ref")
        final_responses = [
            entry
            for entry in _events(items, "fast_brain.speak")
            if _data(entry[1]).get("cause_ref") == run_handoff_ref
        ]
        if not final_responses or final_responses[0][0] <= run_handoff_index:
            findings.append(
                _finding(
                    "final_response_missing",
                    run_handoff,
                    "FastBrain must close from the terminal run handoff",
                )
            )

    artifact_gates: dict[str, list[tuple[int, Mapping[str, Any]]]] = {}
    for gate_index, gate in _events(items, "artifact.gate"):
        artifact_gates.setdefault(str(_data(gate).get("name")), []).append((gate_index, gate))
    missing_gates = sorted(_REQUIRED_ARTIFACT_GATES - artifact_gates.keys())
    if missing_gates:
        findings.append(_finding("artifact_gate_missing", None, f"missing gates: {missing_gates}"))
    for name in sorted(_REQUIRED_ARTIFACT_GATES & artifact_gates.keys()):
        entries = artifact_gates[name]
        if len(entries) != 1:
            findings.append(
                _finding(
                    "artifact_gate_count",
                    entries[1][1] if len(entries) > 1 else None,
                    f"artifact gate {name} must appear exactly once",
                )
            )
        if any(index <= completion_index for index, _record in entries):
            findings.append(
                _finding(
                    "artifact_gate_order",
                    entries[0][1],
                    "artifact gates must inspect the final workspace after turn completion",
                )
            )
        if any(_data(record).get("passed") is not True for _index, record in entries):
            findings.append(
                _finding(
                    "artifact_gate_failed",
                    entries[0][1],
                    f"artifact gate {name} did not pass",
                )
            )

    return TrajectoryReport(tuple(findings))


def build_judge_view(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Return a field-allowlisted view suitable for a future Qwen-Max judge call."""
    events: list[dict[str, Any]] = []
    for record in records:
        if record.get("judge_visibility") != "include":
            continue
        kind = record.get("kind")
        if not isinstance(kind, str) or kind not in _JUDGE_FIELDS:
            continue
        data = _data(record)
        events.append(
            {
                "event_ref": record.get("event_ref"),
                "t_ms": record.get("t_ms"),
                "actor": record.get("actor"),
                "kind": kind,
                "data": {key: data[key] for key in _JUDGE_FIELDS[kind] if key in data},
            }
        )
    return {"schema_version": 1, "events": events}


def validate_judge_output(
    output: Mapping[str, Any], judge_view: Mapping[str, Any]
) -> tuple[TrajectoryFinding, ...]:
    """Validate judge structure and fence cited evidence to the sanitized view."""
    findings: list[TrajectoryFinding] = []
    if output.get("verdict") not in {"pass", "finding"}:
        findings.append(_finding("judge_invalid_verdict", None, "verdict must be pass or finding"))

    scores = output.get("scores")
    if not isinstance(scores, Mapping) or any(
        isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= 4
        for score in scores.values()
    ):
        findings.append(
            _finding("judge_invalid_scores", None, "scores must be integers from 0 to 4")
        )

    visible_refs = {
        event.get("event_ref")
        for event in judge_view.get("events", ())
        if isinstance(event, Mapping) and isinstance(event.get("event_ref"), str)
    }
    evidence_refs = output.get("evidence_refs")
    if not isinstance(evidence_refs, Sequence) or isinstance(evidence_refs, (str, bytes)):
        findings.append(
            _finding("judge_invalid_evidence_refs", None, "evidence_refs must be a list")
        )
    else:
        unknown = [
            ref for ref in evidence_refs if not isinstance(ref, str) or ref not in visible_refs
        ]
        if unknown:
            findings.append(
                _finding(
                    "judge_unknown_evidence_ref",
                    None,
                    f"unknown or hidden evidence refs: {unknown}",
                )
            )

    if not isinstance(output.get("summary"), str):
        findings.append(_finding("judge_invalid_summary", None, "summary must be text"))
    return tuple(findings)
