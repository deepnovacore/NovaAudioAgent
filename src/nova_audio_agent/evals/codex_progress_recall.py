"""Privacy-safe evidence gates for selective Codex progress and recall live takes.

Production routing is channel-policy generic. This scenario evaluator deliberately accepts only
``codex:N`` attention and selected-progress refs because it validates the Codex-specific demo.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, TypeAlias

Backend = Literal["synthetic_live", "orb_live"]
EvidenceRecord: TypeAlias = Mapping[str, object]

# A one-minute Orb take is normally a few thousand records. The byte caps align with
# the JSONL line and live in-memory limits while leaving ample rehearsal headroom.
MAX_EVIDENCE_RECORDS = 50_000
MAX_SAFE_EVENTS = 10_000
MAX_EVIDENCE_RECORD_BYTES = 1024 * 1024
MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
MAX_RECALL_HITS = 5
MAX_RECALL_SCAN = 500
MAX_MEMORY_REF_CHARS = 160

GATES = (
    "single_delegate",
    "declined_progress",
    "selected_progress",
    "selected_host_injected_once",
    "recall_once",
    "silent_ref_recalled",
    "status_never_called",
    "no_duplicate_progress_authority",
    "telemetry_privacy",
    "timings_observed",
)
ORB_GATES = (*GATES, "memory_board_evidence")

_SUPPORTED_FIELDS: dict[str, frozenset[str]] = {
    "codex.dispatch": frozenset({"delegate_id"}),
    "codex.handoff": frozenset({"delegate_id", "outcome"}),
    "attention.decision": frozenset({"channel", "memory_ref", "speak", "selected"}),
    "tool.admission": frozenset({"logical_name", "outcome"}),
    "memory.recall": frozenset(
        {
            "query_digest",
            "scope",
            "state",
            "raw_scanned",
            "searched_count",
            "scan_truncated",
            "hit_count",
            "hit_refs",
            "matches",
            "omitted",
            "elapsed",
        }
    ),
    "hostitem.injected": frozenset({"event_id"}),
    "playback.attribution": frozenset({"target", "memory_ref"}),
    "renderer.ack": frozenset(
        {"kind", "utterance_id", "generation_epoch", "t_render_ms", "played_ms"}
    ),
}
_RECORD_FIELDS = frozenset({"ts", "kind", "payload"})
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_MEMORY_REF = re.compile(r"^[a-z][a-z0-9_]*:[1-9][0-9]*$")
_CODEX_REF = re.compile(r"^codex:[1-9][0-9]*$")
_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_ADMISSION_OUTCOMES = frozenset({"inline", "sync", "delegated", "rejected", "superseded"})
_RENDERER_KINDS = frozenset(
    {"playback_started", "playback_done", "playback_stopped", "playback_cleared"}
)
_PLAYBACK_TARGETS = frozenset({"selected_progress", "memory_recall"})


class EvidenceValidationError(ValueError):
    """The evidence harness supplied malformed or non-allowlisted data."""


@dataclass(frozen=True, slots=True)
class GateResult:
    name: str
    passed: bool


@dataclass(frozen=True, slots=True)
class EvaluationReport:
    backend: Backend
    harness_valid: bool
    gates: tuple[GateResult, ...]
    timings_ms: Mapping[str, float | None]
    safe_events: tuple[dict[str, object], ...]
    invalid_reason: str | None = None

    @property
    def passed(self) -> bool:
        return self.harness_valid and all(gate.passed for gate in self.gates)


def safe_filter_codex_progress_recall(
    records: Sequence[EvidenceRecord],
) -> tuple[dict[str, object], ...]:
    """Validate relevant records and return the content-free evidence stream."""
    normalized = _validated_records(records)
    return tuple(_safe_record(record) for record in normalized)


def evaluate_codex_progress_recall(
    records: Sequence[EvidenceRecord],
    *,
    backend: Backend,
    board_refs: frozenset[str] | None = None,
) -> EvaluationReport:
    """Evaluate shared gates plus the Orb-only Memory Board evidence gate."""
    if backend not in {"synthetic_live", "orb_live"}:
        raise ValueError("unknown codex-progress-recall backend")
    try:
        normalized = _validated_records(records)
    except EvidenceValidationError as exc:
        return EvaluationReport(
            backend=backend,
            harness_valid=False,
            gates=tuple(
                GateResult(name, False) for name in (ORB_GATES if backend == "orb_live" else GATES)
            ),
            timings_ms={
                "decision_to_first_audio": None,
                "recall_to_first_audio": None,
            },
            safe_events=(),
            invalid_reason=str(exc),
        )

    by_kind = {
        kind: tuple(record for record in normalized if record["kind"] == kind)
        for kind in _SUPPORTED_FIELDS
    }
    positions = {id(record): index for index, record in enumerate(normalized)}
    dispatches = by_kind["codex.dispatch"]
    decisions = by_kind["attention.decision"]
    admissions = by_kind["tool.admission"]
    recalls = by_kind["memory.recall"]
    injections = by_kind["hostitem.injected"]
    playback_attributions = by_kind["playback.attribution"]

    declined = tuple(
        record
        for record in decisions
        if _payload(record)
        == {
            "channel": "codex",
            "memory_ref": _payload(record)["memory_ref"],
            "speak": False,
            "selected": False,
        }
    )
    selected = tuple(
        record
        for record in decisions
        if _payload(record)
        == {
            "channel": "codex",
            "memory_ref": _payload(record)["memory_ref"],
            "speak": True,
            "selected": True,
        }
    )
    required_board_refs = {str(_payload(record)["memory_ref"]) for record in (*declined, *selected)}
    for record in recalls:
        required_board_refs.update(
            str(ref) for ref in _payload(record)["hit_refs"] if str(ref).startswith("codex:")
        )
    memory_board_ok = (
        backend == "synthetic_live" or board_refs is not None and required_board_refs <= board_refs
    )
    canonical_decisions = len(decisions) == len(declined) + len(selected)
    declined_ok = canonical_decisions and len(declined) >= 1
    selected_ok = (
        canonical_decisions
        and len(selected) == 1
        and declined_ok
        and all(
            _payload(selected[0])["memory_ref"] != _payload(record)["memory_ref"]
            for record in declined
        )
        and any(positions[id(record)] < positions[id(selected[0])] for record in declined)
    )
    suggestion_injections = tuple(
        record
        for record in injections
        if str(_payload(record)["event_id"]).startswith("suggestion:")
    )
    direct_progress_injections = tuple(
        record for record in injections if str(_payload(record)["event_id"]).startswith("progress:")
    )
    selected_host_basic = (
        selected_ok
        and len(suggestion_injections) == 1
        and positions[id(selected[0])] < positions[id(suggestion_injections[0])]
    )

    recall_admissions = tuple(
        record for record in admissions if _payload(record)["logical_name"] == "memory.recall"
    )
    status_admissions = tuple(
        record for record in admissions if _payload(record)["logical_name"] == "codex.status"
    )
    codex_run_admissions = tuple(
        record for record in admissions if _payload(record)["logical_name"] == "codex.run"
    )
    codex_run_ok = not codex_run_admissions
    if backend == "orb_live" and len(dispatches) == 1 and len(codex_run_admissions) == 1:
        codex_run_ok = (
            _payload(codex_run_admissions[0])["outcome"] == "delegated"
            and positions[id(codex_run_admissions[0])] < positions[id(dispatches[0])]
        )
    recall_admission = recall_admissions[0] if len(recall_admissions) == 1 else None
    early_terminals = tuple(
        record
        for record in by_kind["codex.handoff"]
        if recall_admission is not None and positions[id(record)] < positions[id(recall_admission)]
    ) + tuple(
        record
        for record in injections
        if recall_admission is not None
        and str(_payload(record)["event_id"]).startswith("final:")
        and positions[id(record)] < positions[id(recall_admission)]
    )
    recall_once = (
        len(recall_admissions) == 1
        and _payload(recall_admissions[0])["outcome"] == "inline"
        and len(recalls) == 1
        and positions[id(recall_admissions[0])] < positions[id(recalls[0])]
        and not early_terminals
    )
    silent_recalled = (
        recall_once
        and declined_ok
        and any(
            _payload(record)["memory_ref"] in _payload(recalls[0])["hit_refs"]
            for record in declined
        )
    )

    selected_attributions = tuple(
        record
        for record in playback_attributions
        if _payload(record)["target"] == "selected_progress"
    )
    selected_window_audio = tuple(
        record
        for record in selected_attributions
        if selected_host_basic
        and len(selected_attributions) == 1
        and _payload(record)["memory_ref"] == _payload(selected[0])["memory_ref"]
        and recall_admission is not None
        and positions[id(record)] > positions[id(suggestion_injections[0])]
        and positions[id(record)] < positions[id(recall_admission)]
    )
    selected_host_ok = selected_host_basic and len(selected_window_audio) == 1
    selected_audio = selected_window_audio[0] if selected_host_ok else None
    recall_attributions = tuple(
        record for record in playback_attributions if _payload(record)["target"] == "memory_recall"
    )
    recall_audio_candidates = tuple(
        record
        for record in recall_attributions
        if recall_once
        and len(recall_attributions) == 1
        and positions[id(record)] > positions[id(recalls[0])]
    )
    recall_audio = recall_audio_candidates[0] if len(recall_audio_candidates) == 1 else None
    decision_to_audio = (
        None
        if selected_audio is None or not selected_ok
        else _latency_ms(selected[0], selected_audio)
    )
    recall_to_audio = (
        None
        if recall_audio is None or not recall_once
        else _latency_ms(recall_admissions[0], recall_audio)
    )
    timings = {
        "decision_to_first_audio": decision_to_audio,
        "recall_to_first_audio": recall_to_audio,
    }
    timing_ok = all(
        type(value) is float and math.isfinite(value) and value >= 0 for value in timings.values()
    )

    gate_values = {
        "single_delegate": (
            len(dispatches) == 1
            and bool(decisions)
            and positions[id(dispatches[0])] < positions[id(decisions[0])]
            and codex_run_ok
        ),
        "declined_progress": declined_ok,
        "selected_progress": selected_ok,
        "selected_host_injected_once": selected_host_ok,
        "recall_once": recall_once,
        "silent_ref_recalled": silent_recalled,
        "status_never_called": not status_admissions,
        "no_duplicate_progress_authority": not direct_progress_injections,
        "telemetry_privacy": True,
        "timings_observed": timing_ok,
    }
    if backend == "orb_live":
        gate_values["memory_board_evidence"] = memory_board_ok
    return EvaluationReport(
        backend=backend,
        harness_valid=True,
        gates=tuple(
            GateResult(name, gate_values[name])
            for name in (ORB_GATES if backend == "orb_live" else GATES)
        ),
        timings_ms=timings,
        safe_events=tuple(_safe_record(record) for record in normalized),
    )


def _validated_records(records: Sequence[EvidenceRecord]) -> tuple[dict[str, object], ...]:
    if isinstance(records, (str, bytes)):
        raise EvidenceValidationError("records must be a sequence of objects")
    if len(records) > MAX_EVIDENCE_RECORDS:
        raise EvidenceValidationError("evidence record budget exceeded")
    normalized: list[dict[str, object]] = []
    total_bytes = 0
    previous_ts = -math.inf
    for index, raw in enumerate(records):
        record_bytes = _serialized_record_bytes(raw, index=index)
        if record_bytes > MAX_EVIDENCE_RECORD_BYTES:
            raise EvidenceValidationError("evidence per-record byte budget exceeded")
        total_bytes += record_bytes
        if total_bytes > MAX_EVIDENCE_BYTES:
            raise EvidenceValidationError("evidence aggregate byte budget exceeded")
        if not isinstance(raw, Mapping) or set(raw) != _RECORD_FIELDS:
            raise EvidenceValidationError(f"record {index} has invalid fields")
        ts = raw.get("ts")
        kind = raw.get("kind")
        payload = raw.get("payload")
        if not _nonnegative_number(ts) or float(ts) < previous_ts:
            raise EvidenceValidationError(f"record {index} has invalid timestamp")
        if type(kind) is not str or not kind:
            raise EvidenceValidationError(f"record {index} has invalid kind")
        if not isinstance(payload, Mapping):
            raise EvidenceValidationError(f"record {index} has invalid payload")
        previous_ts = float(ts)
        if kind not in _SUPPORTED_FIELDS:
            continue
        if kind == "renderer.ack":
            renderer_kind = payload.get("kind")
            if type(renderer_kind) is str and renderer_kind not in _RENDERER_KINDS:
                continue
        fields = _SUPPORTED_FIELDS[kind]
        if kind == "renderer.ack":
            if not set(payload) <= fields:
                raise EvidenceValidationError(f"{kind} has unapproved fields")
        elif kind == "playback.attribution":
            if set(payload) not in ({"target"}, {"target", "memory_ref"}):
                raise EvidenceValidationError(f"{kind} has unapproved fields")
        elif set(payload) != fields:
            raise EvidenceValidationError(f"{kind} has unapproved fields")
        record = {"ts": float(ts), "kind": kind, "payload": dict(payload)}
        _validate_payload(record)
        if len(normalized) >= MAX_SAFE_EVENTS:
            raise EvidenceValidationError("safe event budget exceeded")
        normalized.append(record)
    return tuple(normalized)


def _validate_payload(record: dict[str, object]) -> None:
    kind = str(record["kind"])
    payload = _payload(record)
    if kind == "attention.decision":
        if (
            payload["channel"] != "codex"
            or not _valid_memory_ref(payload["memory_ref"], codex_only=True)
            or type(payload["speak"]) is not bool
            or type(payload["selected"]) is not bool
        ):
            raise EvidenceValidationError("attention.decision has invalid values")
    elif kind == "tool.admission":
        if (
            type(payload["logical_name"]) is not str
            or str(payload["logical_name"]) not in {"memory.recall", "codex.status", "codex.run"}
            or type(payload["outcome"]) is not str
            or payload["outcome"] not in _ADMISSION_OUTCOMES
        ):
            raise EvidenceValidationError("tool.admission has invalid values")
    elif kind == "memory.recall":
        _validate_recall(payload)
    elif kind == "renderer.ack":
        _validate_renderer(payload)
    elif kind == "playback.attribution":
        target = payload["target"]
        if target not in _PLAYBACK_TARGETS:
            raise EvidenceValidationError("playback.attribution has invalid values")
        if target == "selected_progress":
            if set(payload) != {"target", "memory_ref"} or not _valid_memory_ref(
                payload["memory_ref"], codex_only=True
            ):
                raise EvidenceValidationError("playback.attribution has invalid values")
        elif set(payload) != {"target"}:
            raise EvidenceValidationError("playback.attribution has invalid values")
    elif kind == "codex.handoff":
        if (
            not _valid_id(payload["delegate_id"])
            or type(payload["outcome"]) is not str
            or payload["outcome"] not in {"ok", "refused", "failed", "unknown"}
        ):
            raise EvidenceValidationError("codex.handoff has invalid values")
    elif kind == "codex.dispatch":
        if not _valid_id(payload["delegate_id"]):
            raise EvidenceValidationError("codex.dispatch has invalid delegate")
    elif kind == "hostitem.injected" and not _valid_id(payload["event_id"]):
        raise EvidenceValidationError("hostitem.injected has invalid event")


def _validate_recall(payload: dict[str, object]) -> None:
    hit_refs = payload["hit_refs"]
    matches = payload["matches"]
    counts = ("raw_scanned", "searched_count", "hit_count", "omitted")
    malformed = (
        type(payload["query_digest"]) is not str
        or _DIGEST.fullmatch(str(payload["query_digest"])) is None
        or payload["scope"] not in ("recent", "any")
        or payload["state"] not in ("ok", "empty", "error")
        or any(type(payload[key]) is not int or int(payload[key]) < 0 for key in counts)
        or type(payload["scan_truncated"]) is not bool
        or not isinstance(hit_refs, (list, tuple))
        or len(hit_refs) > MAX_RECALL_HITS
        or any(not _valid_memory_ref(ref) for ref in hit_refs)
        or len(set(hit_refs)) != len(hit_refs)
        or not isinstance(matches, Mapping)
        or set(matches) != {"lexical", "recency_fallback"}
        or any(type(value) is not int or value < 0 for value in matches.values())
        or not _nonnegative_number(payload["elapsed"])
    )
    if malformed:
        raise EvidenceValidationError("memory.recall has invalid values")
    raw_scanned = int(payload["raw_scanned"])
    searched_count = int(payload["searched_count"])
    hit_count = int(payload["hit_count"])
    omitted = int(payload["omitted"])
    lexical = int(matches["lexical"])
    recency = int(matches["recency_fallback"])
    state = payload["state"]
    coherent_counts = (
        raw_scanned <= MAX_RECALL_SCAN
        and searched_count <= MAX_RECALL_SCAN
        and omitted <= MAX_RECALL_SCAN
        and hit_count <= MAX_RECALL_HITS
        and hit_count == len(hit_refs)
        and hit_count == lexical + recency
        and hit_count <= searched_count <= raw_scanned
        and omitted <= searched_count - hit_count
        and not (lexical and recency)
        and not (payload["scope"] == "recent" and payload["scan_truncated"] is True)
    )
    if state == "error":
        coherent_state = (
            raw_scanned == searched_count == hit_count == omitted == lexical == recency == 0
            and payload["scan_truncated"] is False
        )
    elif state == "empty":
        coherent_state = searched_count == hit_count == omitted == lexical == recency == 0
    else:
        coherent_state = hit_count > 0 and searched_count > 0
        if recency:
            coherent_state = coherent_state and hit_count + omitted == searched_count
    if not coherent_counts or not coherent_state:
        raise EvidenceValidationError("memory.recall has contradictory values")


def _validate_renderer(payload: dict[str, object]) -> None:
    if type(payload.get("kind")) is not str or payload.get("kind") not in _RENDERER_KINDS:
        raise EvidenceValidationError("renderer.ack has invalid kind")
    required = {"kind", "utterance_id", "generation_epoch"}
    if not required <= set(payload):
        raise EvidenceValidationError("renderer.ack is incomplete")
    if not _valid_id(payload["utterance_id"]):
        raise EvidenceValidationError("renderer.ack has invalid utterance")
    epoch = payload["generation_epoch"]
    if type(epoch) is not int or epoch < 0:
        raise EvidenceValidationError("renderer.ack has invalid generation")
    for key in ("t_render_ms", "played_ms"):
        if key in payload and not _nonnegative_number(payload[key]):
            raise EvidenceValidationError(f"renderer.ack has invalid {key}")


def _safe_record(record: dict[str, object]) -> dict[str, object]:
    kind = str(record["kind"])
    payload = _payload(record)
    if kind == "codex.dispatch":
        safe_payload: dict[str, object] = {"count": 1}
    elif kind == "codex.handoff":
        safe_payload = {"outcome": payload["outcome"]}
    elif kind == "attention.decision":
        safe_payload = dict(payload)
    elif kind == "tool.admission":
        safe_payload = dict(payload)
    elif kind == "memory.recall":
        safe_payload = {
            key: payload[key]
            for key in (
                "raw_scanned",
                "searched_count",
                "scan_truncated",
                "hit_count",
                "hit_refs",
                "omitted",
            )
        }
    elif kind == "hostitem.injected":
        event_id = str(payload["event_id"])
        safe_payload = {
            "suggestion": event_id.startswith("suggestion:"),
            "direct_progress": event_id.startswith("progress:"),
        }
    elif kind == "playback.attribution":
        safe_payload = {str(payload["target"]): True}
    else:
        safe_payload = {str(payload["kind"]): True}
    return {"ts": record["ts"], "kind": kind, "payload": safe_payload}


def _payload(record: Mapping[str, object]) -> dict[str, object]:
    payload = record["payload"]
    assert isinstance(payload, dict)
    return payload


def _ts(record: Mapping[str, object]) -> float:
    return float(record["ts"])


def _latency_ms(start: Mapping[str, object], end: Mapping[str, object]) -> float | None:
    latency = (_ts(end) - _ts(start)) * 1000.0
    return latency if math.isfinite(latency) and latency >= 0 else None


def _nonnegative_number(value: object) -> bool:
    return type(value) in {int, float} and math.isfinite(float(value)) and float(value) >= 0


def _serialized_record_bytes(raw: object, *, index: int) -> int:
    try:
        encoded = json.dumps(
            raw,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError) as exc:
        raise EvidenceValidationError(f"record {index} is not JSON serializable") from exc
    return len(encoded) + 1


def _valid_memory_ref(value: object, *, codex_only: bool = False) -> bool:
    pattern = _CODEX_REF if codex_only else _MEMORY_REF
    return (
        type(value) is str
        and len(value) <= MAX_MEMORY_REF_CHARS
        and pattern.fullmatch(value) is not None
    )


def _valid_id(value: object) -> bool:
    return type(value) is str and _OPAQUE_ID.fullmatch(value) is not None
