"""Deterministic records and seven-gate evaluator for camera watch alerts."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from nova_audio_agent.clock import Clock, RealClock

SCENARIO_ID = "qwen-watch-alert.v1"
GATES = (
    "dispatch_acknowledged",
    "vision_hit_observed",
    "hit_to_speech_bounded",
    "announcement_semantics",
    "assistant_preemption_policy",
    "user_speech_protected",
    "status_same_turn",
)
REPEAT_GATES = (
    "single_start_delegate",
    "first_edge_delivered",
    "persistent_true_suppressed",
    "two_false_reset_observed",
    "second_edge_delivered",
    "unique_hit_identity",
    "stop_authoritative",
    "board_lifecycle_complete",
)
_REPEAT_BOARD_STATES = frozenset({"armed", "hit", "cooling", "waiting_reset"})
_FORBIDDEN_SPEECH = ("delegate_id", "frame_digest", "media_ref", "outcome", "hit=")
_MAX_HIT_TO_SPEECH_MS = 35_000.0
_LIVE_NOT_APPLICABLE = frozenset({"assistant_preemption_policy", "user_speech_protected"})
_GROUNDING_PREFIXES = (
    "监控条件",
    "如果",
    "当",
    "画面中",
    "画面",
    "出现",
    "发现",
    "检测到",
    "看到",
)
_GROUNDING_RELATIONS = ("出现在", "出现")
_SUBJECT_TO_LOCATION_MARKERS = (
    "出现在",
    "站在",
    "站上",
    "跳到了",
    "跳到",
    "跳上",
    "落在",
    "爬到",
    "爬上",
    "待在",
    "趴在",
    "躺在",
    "坐在",
    "位于",
    "在",
)
_LOCATION_TO_SUBJECT_MARKERS = (
    "出现",
    "发现",
    "看到",
    "有",
    "站着",
    "躺着",
    "趴着",
    "坐着",
    "待着",
    "停着",
)
_RELATION_NEGATION_PREFIXES = (
    "没有",
    "不是",
    "没",
    "未",
    "并非",
    "不",
)
_NON_NEGATING_RELATION_PREFIXES = ("不仅", "不但")
_WRONG_LOCATION_RELATIONS = (
    "旁边",
    "附近",
    "下面",
    "下方",
    "前面",
    "后面",
    "外面",
    "上方",
    "上空",
)
_LOCATION_SURFACES = ("坐垫", "座垫", "垫子", "扶手", "靠背")
_GROUNDING_CLAUSE_SEPARATORS = "，。！？、,.;:!?："
_NEGATION_PREFIXES = (
    "没有出现在",
    "未出现在",
    "没出现在",
    "没有出现",
    "没有检测到",
    "没有发现",
    "没有看到",
    "未检测到",
    "未发现",
    "看不到",
    "不在",
    "没有",
    "并非",
    "未",
    "没",
    "无",
    "不",
)
_NEGATION_SUFFIXES = ("并未出现", "没有出现", "未出现", "不存在", "不在", "不见")

Backend = Literal["deterministic", "live"]
GateStatus = Literal["passed", "failed", "not_applicable"]
_RECORD_FIELDS = {
    "dispatch.ack": frozenset({"executor", "delegate_id"}),
    "dispatch.spoken": frozenset({"delegate_id", "transcript"}),
    "vision.verdict": frozenset({"delegate_id", "frame_digest", "hit", "condition", "observation"}),
    "watch.observation": frozenset(
        {"delegate_id", "executor", "event_id", "hit", "state", "hit_count", "reset_count"}
    ),
    "watch.handoff": frozenset({"delegate_id", "executor", "hit", "outcome", "state"}),
    "watch.stop": frozenset(
        {"start_delegate_id", "stop_delegate_id", "outcome", "stopped", "start_state"}
    ),
    "preemption": frozenset({"executor", "hit", "assistant_cancelled", "user_speaking"}),
    "status.sync": frozenset({"executor", "sync_result", "state"}),
    "playback.delivered": frozenset({"delegate_id", "event_id", "transcript"}),
}


@dataclass(frozen=True, slots=True)
class Finding:
    code: str
    event_ref: str | None
    detail: str


@dataclass(frozen=True, slots=True)
class GateResult:
    name: str
    status: GateStatus
    passed: bool | None
    findings: tuple[Finding, ...]


@dataclass(frozen=True, slots=True)
class WatchAlertReport:
    scenario_id: str
    backend: Backend
    findings: tuple[Finding, ...]
    gates: tuple[GateResult, ...]
    metrics: Mapping[str, Any]

    @property
    def passed(self) -> bool:
        return all(gate.status != "failed" for gate in self.gates)


class WatchAlertRecorder:
    """Allowlisted scenario artifact recorder with an injected time source."""

    def __init__(self, *, clock: Clock | None = None) -> None:
        self._clock = clock or RealClock()
        self._started = self._clock.now()
        self._records: list[dict[str, Any]] = []

    @property
    def records(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(self._records)

    def record(self, kind: str, data: Mapping[str, Any]) -> Mapping[str, Any]:
        allowed = _RECORD_FIELDS.get(kind)
        if allowed is None:
            raise ValueError("unsupported watch-alert event")
        sanitized = {
            key: value
            for key, value in data.items()
            if key in allowed and type(value) in {str, bool, int, float}
        }
        record = {
            "event_ref": f"e{len(self._records) + 1:03d}",
            "t_ms": max(0.0, (self._clock.now() - self._started) * 1000.0),
            "kind": kind,
            "data": sanitized,
        }
        self._records.append(record)
        return record


def evaluate_watch_alert(
    records: Sequence[Mapping[str, Any]],
    *,
    backend: Backend = "deterministic",
    minimum_pre_hit_misses: int = 0,
) -> WatchAlertReport:
    if backend not in {"deterministic", "live"}:
        raise ValueError("unknown watch-alert backend")
    if type(minimum_pre_hit_misses) is not int or minimum_pre_hit_misses < 0:
        raise ValueError("minimum_pre_hit_misses must be a non-negative integer")
    dispatches = _events(records, "dispatch.ack")
    spoken_dispatches = _events(records, "dispatch.spoken")
    verdicts = _events(records, "vision.verdict")
    observations = _events(records, "watch.observation")
    handoffs = _events(records, "watch.handoff")
    deliveries = _events(records, "playback.delivered")
    preemptions = _events(records, "preemption")
    statuses = _events(records, "status.sync")

    dispatch_findings: list[Finding] = []
    accepted_delegates = {
        delegate_id: (record, executor)
        for record in dispatches
        if (delegate_id := _text(_data(record).get("delegate_id")))
        and (executor := _text(_data(record).get("executor")))
    }
    accepted_delegate_ids = set(accepted_delegates)
    if not accepted_delegate_ids:
        dispatch_findings.append(
            _finding("dispatch_ack_missing", None, "no accepted watch delegate")
        )
    hit_findings: list[Finding] = []
    real_hit: Mapping[str, Any] | None = None
    hit_marker: Mapping[str, Any] | None = None
    for verdict in verdicts:
        data = _data(verdict)
        digest = data.get("frame_digest")
        delegate_id = data.get("delegate_id")
        accepted = accepted_delegates.get(delegate_id) if isinstance(delegate_id, str) else None
        if (
            data.get("hit") is True
            and isinstance(digest, str)
            and len(digest) == 64
            and isinstance(delegate_id, str)
            and accepted is not None
            and _before(accepted[0], verdict)
        ):
            executor = accepted[1]
            candidate_observations = [
                observation
                for observation in observations
                if _data(observation).get("delegate_id") == delegate_id
                and _data(observation).get("executor") == executor
                and _data(observation).get("hit") is True
                and _before(verdict, observation)
            ]
            invalid_observation = next(
                (
                    observation
                    for observation in candidate_observations
                    if not _valid_observation_event_id(
                        _data(observation).get("event_id"),
                        delegate_id,
                    )
                ),
                None,
            )
            if invalid_observation is not None:
                hit_findings.append(
                    _finding(
                        "observation_identity_invalid",
                        invalid_observation,
                        "observation hit identity was not canonical for its delegate",
                    )
                )
            matching_observation = next(
                (
                    observation
                    for observation in candidate_observations
                    if _valid_observation_event_id(
                        _data(observation).get("event_id"),
                        delegate_id,
                    )
                ),
                None,
            )
            matching_legacy_handoff = next(
                (
                    handoff
                    for handoff in handoffs
                    if _data(handoff).get("delegate_id") == delegate_id
                    and _data(handoff).get("executor") == executor
                    and _data(handoff).get("hit") is True
                    and _data(handoff).get("outcome") == "ok"
                    and _before(verdict, handoff)
                ),
                None,
            )
            matching = matching_observation or matching_legacy_handoff
            if matching is not None:
                real_hit = verdict
                hit_marker = matching
                if matching_observation is not None and not any(
                    _data(handoff).get("delegate_id") == delegate_id
                    and _data(handoff).get("executor") == executor
                    and _data(handoff).get("hit") is False
                    and _data(handoff).get("outcome") == "ok"
                    and _data(handoff).get("state") in {"stopped", "window_elapsed"}
                    and _before(matching_observation, handoff)
                    for handoff in handoffs
                ):
                    hit_findings.append(
                        _finding(
                            "monitor_terminal_missing",
                            matching_observation,
                            "observation hit had no later stopped/window terminal",
                        )
                    )
                break
    if real_hit is None:
        hit_findings.append(
            _finding(
                "vision_hit_missing",
                None,
                "no frame-backed hit matched a monitor observation or legacy handoff",
            )
        )
    pre_hit_miss_digests = {
        digest
        for verdict in verdicts
        if real_hit is not None
        and _before(verdict, real_hit)
        and _data(verdict).get("delegate_id") == _data(real_hit).get("delegate_id")
        and _data(verdict).get("hit") is False
        and isinstance((digest := _data(verdict).get("frame_digest")), str)
        and len(digest) == 64
    }
    if len(pre_hit_miss_digests) < minimum_pre_hit_misses:
        hit_findings.append(
            _finding(
                "pre_hit_misses_missing",
                real_hit,
                "too few distinct non-hit frames preceded the first hit",
            )
        )

    trajectory_delegate_id = (
        _text(_data(real_hit).get("delegate_id")) if real_hit is not None else ""
    )
    acknowledgement_delegate_ids = (
        {trajectory_delegate_id} if trajectory_delegate_id else accepted_delegate_ids
    )
    if not any(
        (delegate_id := _text(_data(record).get("delegate_id"))) in acknowledgement_delegate_ids
        and bool(_text(_data(record).get("transcript")))
        and _before(accepted_delegates[delegate_id][0], record)
        and (real_hit is None or _before(record, real_hit))
        for record in spoken_dispatches
    ):
        dispatch_findings.append(
            _finding(
                "dispatch_speech_missing",
                None,
                "accepted watch delegate had no spoken acknowledgement",
            )
        )

    latency_findings: list[Finding] = []
    hit_to_speech_ms: float | None = None
    delivery: Mapping[str, Any] | None = None
    if real_hit is not None:
        delegate_id = _data(real_hit).get("delegate_id")
        delivery = next(
            (
                record
                for record in deliveries
                if _data(record).get("delegate_id") == delegate_id
                and hit_marker is not None
                and _before(hit_marker, record)
            ),
            None,
        )
        if delivery is not None:
            hit_to_speech_ms = _timestamp(delivery) - _timestamp(real_hit)
    if hit_to_speech_ms is None:
        latency_findings.append(
            _finding("hit_delivery_missing", hit_marker, "hit was not delivered")
        )
    elif not 0 <= hit_to_speech_ms <= _MAX_HIT_TO_SPEECH_MS:
        latency_findings.append(
            _finding("hit_delivery_too_slow", delivery, "hit-to-speech latency exceeded the bound")
        )

    speech_findings: list[Finding] = []
    transcript = _text(_data(delivery).get("transcript")) if delivery is not None else ""
    condition = _text(_data(real_hit).get("condition")) if real_hit is not None else ""
    observation = _text(_data(real_hit).get("observation")) if real_hit is not None else ""
    concepts = tuple(token for token in (condition, observation) if token)
    if not transcript or not _announcement_is_grounded(transcript, concepts):
        speech_findings.append(
            _finding(
                "announcement_not_grounded", delivery, "delivered speech omitted hit semantics"
            )
        )
    if any(marker in transcript for marker in _FORBIDDEN_SPEECH):
        speech_findings.append(
            _finding(
                "announcement_leaked_protocol", delivery, "delivered speech exposed protocol fields"
            )
        )

    assistant_findings: list[Finding] = []
    valid_guard = any(
        _data(record).get("executor") == "guard"
        and _data(record).get("hit") is True
        and _data(record).get("assistant_cancelled") is True
        and _data(record).get("user_speaking") is False
        for record in preemptions
    )
    valid_watch = any(
        _data(record).get("executor") == "watch"
        and _data(record).get("hit") is True
        and _data(record).get("assistant_cancelled") is False
        and _data(record).get("user_speaking") is False
        for record in preemptions
    )
    invalid_cancel = any(
        (_data(record).get("executor") != "guard" or _data(record).get("hit") is not True)
        and _data(record).get("assistant_cancelled") is True
        for record in preemptions
    )
    if not valid_guard or not valid_watch or invalid_cancel:
        assistant_findings.append(
            _finding("assistant_preemption_policy_failed", None, "guard/watch preemption differed")
        )

    user_findings: list[Finding] = []
    user_cases = [record for record in preemptions if _data(record).get("user_speaking") is True]
    if not user_cases:
        user_findings.append(_finding("user_speech_case_missing", None, "no user-speech case"))
    for record in user_cases:
        if _data(record).get("assistant_cancelled") is True:
            user_findings.append(
                _finding("user_speech_preempted", record, "alert cancelled while user was speaking")
            )

    status_findings: list[Finding] = []
    trajectory_dispatch = (
        accepted_delegates.get(_text(_data(real_hit).get("delegate_id")))
        if real_hit is not None
        else None
    )
    if trajectory_dispatch is None or not any(
        _data(record).get("executor") == trajectory_dispatch[1]
        and _data(record).get("sync_result") is True
        and _data(record).get("state") in {"running", "armed", "cooling", "waiting_reset"}
        and _before(trajectory_dispatch[0], record)
        and _before(record, real_hit)
        for record in statuses
    ):
        status_findings.append(
            _finding("running_status_missing", None, "no same-turn running status")
        )

    grouped = (
        dispatch_findings,
        hit_findings,
        latency_findings,
        speech_findings,
        assistant_findings,
        user_findings,
        status_findings,
    )
    gate_results: list[GateResult] = []
    applicable_findings: list[Finding] = []
    for name, gate_findings in zip(GATES, grouped, strict=True):
        if backend == "live" and name in _LIVE_NOT_APPLICABLE:
            gate_results.append(
                GateResult(
                    name=name,
                    status="not_applicable",
                    passed=None,
                    findings=(),
                )
            )
            continue
        findings_tuple = tuple(gate_findings)
        applicable_findings.extend(findings_tuple)
        gate_results.append(
            GateResult(
                name=name,
                status="failed" if findings_tuple else "passed",
                passed=not findings_tuple,
                findings=findings_tuple,
            )
        )
    gates = tuple(gate_results)
    findings = tuple(applicable_findings)
    metrics: dict[str, Any] = {"record_count": len(records)}
    if minimum_pre_hit_misses:
        metrics["pre_hit_misses"] = len(pre_hit_miss_digests)
    if hit_to_speech_ms is not None and math.isfinite(hit_to_speech_ms):
        metrics["hit_to_speech_ms"] = hit_to_speech_ms
    return WatchAlertReport(
        scenario_id=SCENARIO_ID,
        backend=backend,
        findings=findings,
        gates=gates,
        metrics=metrics,
    )


def evaluate_repeat_watch_alert(
    records: Sequence[Mapping[str, Any]],
    *,
    board_message: str,
    backend: Backend = "deterministic",
) -> WatchAlertReport:
    """Evaluate the repeat-only lifecycle without invalidating legacy one-edge artifacts."""
    if backend not in {"deterministic", "live"}:
        raise ValueError("unknown watch-alert backend")
    dispatches = _events(records, "dispatch.ack")
    accepted = [
        record
        for record in dispatches
        if _text(_data(record).get("delegate_id"))
        and _text(_data(record).get("executor")) in {"watch", "guard"}
    ]
    delegate_id = _text(_data(accepted[0]).get("delegate_id")) if len(accepted) == 1 else ""
    executor = _text(_data(accepted[0]).get("executor")) if len(accepted) == 1 else ""
    observations = sorted(
        (
            record
            for record in _events(records, "watch.observation")
            if _data(record).get("delegate_id") == delegate_id
            and _data(record).get("executor") == executor
        ),
        key=lambda record: (_timestamp(record), _event_sequence(record)),
    )
    foreign_observations = [
        record
        for record in _events(records, "watch.observation")
        if _data(record).get("delegate_id") != delegate_id
        or _data(record).get("executor") != executor
    ]
    hits = [record for record in observations if _data(record).get("hit") is True]
    verdicts = sorted(
        (
            record
            for record in _events(records, "vision.verdict")
            if _data(record).get("delegate_id") == delegate_id
        ),
        key=lambda record: (_timestamp(record), _event_sequence(record)),
    )
    deliveries = [
        record
        for record in _events(records, "playback.delivered")
        if _data(record).get("delegate_id") == delegate_id
    ]
    terminals = [
        record
        for record in _events(records, "watch.handoff")
        if _data(record).get("delegate_id") == delegate_id
        and _data(record).get("executor") == executor
    ]
    stop_records = _events(records, "watch.stop")
    board_lifecycle, board_hits, board_error = _repeat_board_evidence(board_message, executor)

    single_start_findings: list[Finding] = []
    if len(accepted) != 1 or foreign_observations:
        single_start_findings.append(
            _finding(
                "repeat_start_identity_invalid",
                foreign_observations[0] if foreign_observations else None,
                "repeat evidence did not stay on one accepted start delegate",
            )
        )

    edge_findings: list[list[Finding]] = [[], []]
    hit_verdicts: list[Mapping[str, Any] | None] = []
    used_hit_digests: set[str] = set()
    for index, label in enumerate(("first", "second")):
        hit = hits[index] if len(hits) > index else None
        event_id = _text(_data(hit).get("event_id")) if hit is not None else ""
        prior_verdicts = [
            record
            for record in verdicts
            if hit is not None and _before(record, hit) and (index == 0 or _before(hits[0], record))
        ]
        candidate = prior_verdicts[-1] if prior_verdicts else None
        digest = _text(_data(candidate).get("frame_digest"))
        true_verdict = (
            candidate
            if candidate is not None
            and _data(candidate).get("hit") is True
            and len(digest) == 64
            and digest not in used_hit_digests
            else None
        )
        if true_verdict is not None:
            used_hit_digests.add(digest)
        hit_verdicts.append(true_verdict)
        delivered = (
            any(
                _data(record).get("event_id") == event_id and _before(hit, record)
                for record in deliveries
            )
            if hit is not None and event_id
            else False
        )
        valid_hit = (
            hit is not None
            and _data(hit).get("state") == "hit"
            and _data(hit).get("hit") is True
            and _data(hit).get("hit_count") == index + 1
            and true_verdict is not None
        )
        if index == 0:
            valid_hit = valid_hit and any(
                _data(record).get("state") == "armed"
                and _data(record).get("hit") is False
                and _data(record).get("hit_count") == 0
                and _before(record, true_verdict)
                for record in observations
            )
        if not (valid_hit and delivered):
            edge_findings[index].append(
                _finding(
                    f"{label}_edge_delivery_missing",
                    hit,
                    f"{label} repeat-monitor hit was not delivered with its event identity",
                )
            )

    persistent_findings: list[Finding] = []
    if hits and hit_verdicts[0] is not None:
        first_hit = hits[0]
        later_verdicts = [record for record in verdicts if _before(first_hit, record)]
        first_false_index = next(
            (
                index
                for index, record in enumerate(later_verdicts)
                if _data(record).get("hit") is False
            ),
            None,
        )
        persistent_true = (
            later_verdicts[:first_false_index] if first_false_index is not None else later_verdicts
        )
        hits_before_false = [
            record
            for record in hits
            if first_false_index is None or _before(record, later_verdicts[first_false_index])
        ]
        if (
            len(persistent_true) < 2
            or any(_data(record).get("hit") is not True for record in persistent_true)
            or len(hits_before_false) != 1
        ):
            persistent_findings.append(
                _finding(
                    "persistent_true_not_suppressed",
                    first_hit,
                    "persistent true samples did not remain one semantic hit",
                )
            )
    else:
        persistent_findings.append(
            _finding("persistent_true_not_suppressed", None, "first repeat-monitor hit was missing")
        )

    reset_findings: list[Finding] = []
    expected_host_lifecycle = (
        ("armed", False, 0),
        ("hit", True, 1),
        ("cooling", False, 1),
        ("waiting_reset", False, 1),
        ("armed", False, 1),
        ("hit", True, 2),
        ("cooling", False, 2),
    )
    host_lifecycle = tuple(
        (
            _text(_data(record).get("state")),
            _data(record).get("hit"),
            _data(record).get("hit_count"),
        )
        for record in observations
    )
    if host_lifecycle != expected_host_lifecycle:
        reset_findings.append(
            _finding(
                "repeat_lifecycle_invalid",
                None,
                "host lifecycle did not exactly match the declared two-edge trajectory",
            )
        )
    if len(hits) < 2 or hit_verdicts[1] is None:
        reset_findings.append(
            _finding("repeat_reset_missing", None, "second repeat-monitor edge was missing")
        )
    else:
        between = [
            record
            for record in verdicts
            if _before(hits[0], record) and _before(record, hit_verdicts[1])
        ]
        reset_path = next(
            (
                (first, waiting, second, armed)
                for first, second in zip(between, between[1:])
                if _data(first).get("hit") is False
                and _data(second).get("hit") is False
                and (
                    waiting := next(
                        (
                            record
                            for record in observations
                            if _data(record).get("state") == "waiting_reset"
                            and _data(record).get("hit") is False
                            and _data(record).get("hit_count") == 1
                            and _before(first, record)
                            and _before(record, second)
                        ),
                        None,
                    )
                )
                is not None
                and (
                    armed := next(
                        (
                            record
                            for record in observations
                            if _data(record).get("state") == "armed"
                            and _data(record).get("hit") is False
                            and _data(record).get("hit_count") == 1
                            and _before(second, record)
                            and _before(record, hit_verdicts[1])
                        ),
                        None,
                    )
                )
                is not None
            ),
            None,
        )
        if reset_path is None:
            reset_findings.append(
                _finding(
                    "repeat_reset_missing",
                    hits[1],
                    "two consecutive false verdicts did not visibly re-arm the monitor",
                )
            )

    identity_findings: list[Finding] = []
    hit_ids = [_text(_data(record).get("event_id")) for record in hits[:2]]
    board_hit_refs = [f"{executor}:{item['seq']}" for item in board_hits[:2]]
    if (
        len(hits) < 2
        or any(not _valid_observation_event_id(event_id, delegate_id) for event_id in hit_ids)
        or len(set(hit_ids)) != 2
        or len(board_hit_refs) != 2
        or len(set(board_hit_refs)) != 2
    ):
        identity_findings.append(
            _finding(
                "repeat_hit_identity_invalid",
                hits[1] if len(hits) > 1 else None,
                "the two hits lacked distinct host and Memory identities",
            )
        )

    stop_findings: list[Finding] = []
    stopped = terminals[0] if len(terminals) == 1 else None
    stop_record = stop_records[0] if len(stop_records) == 1 else None
    stop_data = _data(stop_record)
    if (
        stopped is None
        or _data(stopped).get("outcome") != "ok"
        or _data(stopped).get("state") != "stopped"
        or stop_record is None
        or stop_data.get("start_delegate_id") != delegate_id
        or not _text(stop_data.get("stop_delegate_id"))
        or stop_data.get("stop_delegate_id") == delegate_id
        or stop_data.get("outcome") != "ok"
        or stop_data.get("stopped") is not True
        or stop_data.get("start_state") != "stopped"
        or len(hits) < 2
        or not _before(hits[1], stopped)
        or not _before(stopped, stop_record)
        or any(_before(stopped, record) for record in observations)
    ):
        stop_findings.append(
            _finding(
                "repeat_stop_not_authoritative",
                stopped,
                "the accepted monitor did not stop after edge two or emitted a later hit",
            )
        )

    board_findings: list[Finding] = []
    expected_lifecycle = (
        ("armed", 0),
        ("hit", 1),
        ("cooling", 1),
        ("waiting_reset", 1),
        ("armed", 1),
        ("hit", 2),
        ("cooling", 2),
    )
    if (
        board_error is not None
        or tuple(board_lifecycle) != expected_lifecycle
        or [_data(item).get("hit_count") for item in board_hits] != [1, 2]
        or [_text(item.get("trust")) for item in board_hits]
        != ["untrusted_external", "untrusted_external"]
    ):
        board_findings.append(
            _finding(
                "repeat_board_incomplete",
                None,
                board_error or "Board omitted the ordered two-edge lifecycle",
            )
        )

    grouped = (
        single_start_findings,
        edge_findings[0],
        persistent_findings,
        reset_findings,
        edge_findings[1],
        identity_findings,
        stop_findings,
        board_findings,
    )
    gates = tuple(
        GateResult(
            name=name,
            status="failed" if findings else "passed",
            passed=not findings,
            findings=tuple(findings),
        )
        for name, findings in zip(REPEAT_GATES, grouped, strict=True)
    )
    findings = tuple(finding for gate in gates for finding in gate.findings)
    return WatchAlertReport(
        scenario_id=SCENARIO_ID,
        backend=backend,
        findings=findings,
        gates=gates,
        metrics={"record_count": len(records), "hit_count": len(hits)},
    )


def sanitize_repeat_board_message(message: str, executor: str) -> str:
    """Keep only bounded lifecycle identity from a Board frame for durable evidence."""
    try:
        board = json.loads(message)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("invalid Board evidence") from exc
    if not isinstance(board, Mapping) or board.get("type") != "memory.board":
        raise ValueError("invalid Board evidence")
    channels = board.get("channels")
    if not isinstance(channels, list):
        raise ValueError("invalid Board evidence")
    source = next(
        (
            channel
            for channel in channels
            if isinstance(channel, Mapping) and channel.get("name") == executor
        ),
        None,
    )
    if source is None or not isinstance(source.get("items"), list):
        raise ValueError("invalid Board evidence")
    items: list[dict[str, Any]] = []
    for item in source["items"]:
        if not isinstance(item, Mapping):
            raise ValueError("invalid Board evidence")
        seq = item.get("seq")
        trust = item.get("trust")
        try:
            content = json.loads(item.get("content", ""))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("invalid Board evidence") from exc
        if not isinstance(content, Mapping):
            raise ValueError("invalid Board evidence")
        state = content.get("state")
        hit_count = content.get("hit_count")
        if state not in _REPEAT_BOARD_STATES or "op" in content:
            continue
        if type(seq) is not int or seq <= 0 or type(trust) is not str or type(hit_count) is not int:
            raise ValueError("invalid Board evidence")
        items.append(
            {
                "seq": seq,
                "trust": trust,
                "content": json.dumps(
                    {"state": state, "hit_count": hit_count},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            }
        )
    evidence = {
        "type": "memory.board",
        "request_id": "repeat-monitor-evidence",
        "channels": [{"name": executor, "items": items[-50:]}],
    }
    return json.dumps(evidence, ensure_ascii=False, separators=(",", ":"))


def _events(records: Sequence[Mapping[str, Any]], kind: str) -> list[Mapping[str, Any]]:
    return [record for record in records if record.get("kind") == kind]


def _data(record: Mapping[str, Any] | None) -> Mapping[str, Any]:
    if record is None:
        return {}
    data = record.get("data")
    return data if isinstance(data, Mapping) else {}


def _repeat_board_evidence(
    message: str,
    executor: str,
) -> tuple[list[tuple[str, int]], list[Mapping[str, Any]], str | None]:
    try:
        board = json.loads(message)
    except (TypeError, ValueError, json.JSONDecodeError):
        return [], [], "Board evidence was not valid JSON"
    if not isinstance(board, Mapping) or board.get("type") != "memory.board":
        return [], [], "Board evidence had the wrong frame type"
    channels = board.get("channels")
    if not isinstance(channels, list):
        return [], [], "Board evidence had no channels"
    channel = next(
        (
            value
            for value in channels
            if isinstance(value, Mapping) and value.get("name") == executor
        ),
        None,
    )
    if channel is None or not isinstance(channel.get("items"), list):
        return [], [], "Board evidence omitted the monitor channel"
    lifecycle: list[tuple[str, int]] = []
    hits: list[Mapping[str, Any]] = []
    previous_seq = 0
    for item in channel["items"]:
        if not isinstance(item, Mapping) or type(item.get("seq")) is not int:
            return [], [], "Board evidence contained a malformed item"
        seq = item["seq"]
        if seq <= previous_seq:
            return [], [], "Board evidence item identities were not strictly increasing"
        previous_seq = seq
        try:
            content = json.loads(item.get("content", ""))
        except (TypeError, ValueError, json.JSONDecodeError):
            return [], [], "Board evidence contained invalid item JSON"
        if not isinstance(content, Mapping):
            return [], [], "Board evidence contained non-object content"
        state = _text(content.get("state"))
        hit_count = content.get("hit_count")
        if state in _REPEAT_BOARD_STATES and type(hit_count) is int:
            lifecycle.append((state, hit_count))
        if state == "hit":
            hits.append({**item, "data": content})
    return lifecycle, hits, None


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _valid_observation_event_id(value: object, delegate_id: str) -> bool:
    if type(value) is not str:
        return False
    prefix = f"observation:{delegate_id}:"
    if not value.startswith(prefix):
        return False
    sequence = value[len(prefix) :]
    return sequence.isascii() and sequence.isdigit() and sequence[0] != "0"


def _timestamp(record: Mapping[str, Any]) -> float:
    value = record.get("t_ms")
    return float(value) if type(value) in {int, float} else 0.0


def _before(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    first_time = _timestamp(first)
    second_time = _timestamp(second)
    if first_time != second_time:
        return first_time < second_time
    return _event_sequence(first) < _event_sequence(second)


def _event_sequence(record: Mapping[str, Any]) -> int:
    event_ref = record.get("event_ref")
    if isinstance(event_ref, str) and event_ref.startswith("e"):
        try:
            return int(event_ref[1:])
        except ValueError:
            pass
    return -1


def _announcement_is_grounded(transcript: str, concepts: Sequence[str]) -> bool:
    normalized_transcript = _normalize_grounding_text(transcript)
    condition_anchor = _normalize_grounding_text(concepts[0]) if concepts else ""
    changed = True
    while changed:
        changed = False
        for prefix in _GROUNDING_PREFIXES:
            if condition_anchor.startswith(prefix):
                condition_anchor = condition_anchor.removeprefix(prefix)
                changed = True
                break
    relation_anchors = _condition_relation_anchors(condition_anchor)
    if relation_anchors:
        return _contains_positive_relation(transcript, *relation_anchors)
    candidates = [condition_anchor] if len(condition_anchor) >= 2 else []
    candidates.extend(_normalize_grounding_text(concept) for concept in concepts[1:])
    return any(
        candidate and _contains_positive_grounding(normalized_transcript, candidate)
        for candidate in candidates
    )


def _condition_relation_anchors(condition: str) -> tuple[str, ...]:
    for relation in _GROUNDING_RELATIONS:
        if relation not in condition:
            continue
        anchors = tuple(part for part in condition.split(relation) if part)
        return anchors if len(anchors) == 2 else ()
    return ()


def _contains_positive_relation(transcript: str, subject: str, location: str) -> bool:
    normalized_subject = _normalize_grounding_text(subject)
    normalized_location = _normalize_grounding_text(location)
    location_base = normalized_location.removesuffix("上") or normalized_location
    if not normalized_subject or not location_base:
        return False
    for clause in _grounding_clauses(transcript):
        subject_offset = 0
        while (subject_index := clause.find(normalized_subject, subject_offset)) >= 0:
            location_offset = 0
            while (location_index := clause.find(location_base, location_offset)) >= 0:
                location_end = _matching_location_end(
                    clause,
                    location_index,
                    location_base,
                    normalized_location,
                )
                if location_end is not None and subject_index < location_index:
                    between = clause[subject_index + len(normalized_subject) : location_index]
                    if _contains_asserted_relation(between, _SUBJECT_TO_LOCATION_MARKERS):
                        return True
                elif location_end is not None and location_index < subject_index:
                    between = clause[location_end:subject_index]
                    if _contains_asserted_relation(between, _LOCATION_TO_SUBJECT_MARKERS):
                        return True
                location_offset = location_index + len(location_base)
            subject_offset = subject_index + len(normalized_subject)
    return False


def _contains_asserted_relation(value: str, markers: Sequence[str]) -> bool:
    for marker in markers:
        offset = 0
        while (index := value.find(marker, offset)) >= 0:
            if any(
                longer != marker
                and longer.endswith(marker)
                and value[max(0, index + len(marker) - len(longer)) : index + len(marker)] == longer
                for longer in markers
            ):
                offset = index + len(marker)
                continue
            prefix = value[:index]
            if prefix.endswith(_NON_NEGATING_RELATION_PREFIXES) or not prefix.endswith(
                _RELATION_NEGATION_PREFIXES
            ):
                return True
            offset = index + len(marker)
    return False


def _matching_location_end(
    clause: str,
    location_index: int,
    location_base: str,
    expected_location: str,
) -> int | None:
    base_end = location_index + len(location_base)
    if not expected_location.endswith("上"):
        return base_end
    suffix = clause[base_end : base_end + 8]
    if any(marker in suffix for marker in _WRONG_LOCATION_RELATIONS):
        return None
    if suffix.startswith("上"):
        return base_end + 1
    for surface in _LOCATION_SURFACES:
        for prefix in (surface, f"的{surface}"):
            position = len(prefix)
            if suffix.startswith(prefix) and suffix[position:].startswith("上"):
                return base_end + position + 1
    return None


def _grounding_clauses(value: str) -> tuple[str, ...]:
    translation = str.maketrans({separator: "\n" for separator in _GROUNDING_CLAUSE_SEPARATORS})
    return tuple(
        normalized
        for clause in value.translate(translation).splitlines()
        if (normalized := _normalize_grounding_text(clause))
    )


def _contains_positive_grounding(transcript: str, candidate: str) -> bool:
    offset = 0
    while (index := transcript.find(candidate, offset)) >= 0:
        prefix = transcript[max(0, index - 8) : index]
        suffix = transcript[index + len(candidate) : index + len(candidate) + 8]
        prefix_negated = any(prefix.endswith(marker) for marker in _NEGATION_PREFIXES)
        suffix_negated = any(suffix.startswith(marker) for marker in _NEGATION_SUFFIXES)
        if not prefix_negated and not suffix_negated:
            return True
        offset = index + len(candidate)
    return False


def _normalize_grounding_text(value: str) -> str:
    compact = "".join(
        character for character in value if character not in " \t\r\n，。！？、,.;:!?："
    )
    return compact.replace("画面里", "画面中").replace("下面", "下方")


def _finding(
    code: str,
    record: Mapping[str, Any] | None,
    detail: str,
) -> Finding:
    event_ref = record.get("event_ref") if record is not None else None
    return Finding(
        code=code,
        event_ref=event_ref if isinstance(event_ref, str) else None,
        detail=detail,
    )
