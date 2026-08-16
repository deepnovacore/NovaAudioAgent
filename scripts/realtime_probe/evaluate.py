from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable

from .models import GateResult, ProbeEvent


_USER_ATTRIBUTION = re.compile(r"(?:你|用户)(?:刚才|之前|方才)?(?:说|告诉|提到|汇报|表示|要求)")
_BACKGROUND_SOURCE = re.compile(r"Codex|后台|委派任务", re.IGNORECASE)
_IN_PROGRESS = re.compile(r"仍在|还在|进行中|尚未完成")
_MULTIPLICATION_OPERAND = re.compile(r"(?:七|7)(?:乘以|乘|x|×)(?:八|8)")
_RESULT_CLAIM = re.compile(
    r"(?:等于|(?<!不)是|得|答案(?:是|为)?|结果(?:是|为)?|得数(?:是|为)?)(五十六|[0-9]+|[零一二三四五六七八九十百千万两]+)"
)


def _ordered(events: Iterable[ProbeEvent]) -> list[ProbeEvent]:
    return sorted(events, key=lambda event: (event.t_ms, event.event_ref))


def _events(events: Iterable[ProbeEvent], kind: str) -> list[ProbeEvent]:
    return [event for event in events if event.kind == kind]


def _positive_user_attribution(text: str) -> bool:
    normalized = re.sub(r"(?:不是|并非)(?:你|用户)(?:刚才|之前|方才)?说(?:的)?", "", text)
    return bool(_USER_ATTRIBUTION.search(normalized))


def _normalized_probe_text(text: str) -> str:
    return re.sub(r"[\s，,。！？?；;：:]", "", text).lower()


def _only_56_result_claims(text: str) -> bool:
    return all(value in {"56", "五十六"} for value in _RESULT_CLAIM.findall(text))


def _is_multiplication_question(text: str) -> bool:
    normalized = _normalized_probe_text(text)
    return (
        bool(_MULTIPLICATION_OPERAND.search(normalized))
        and bool(re.search(r"多少|几", normalized))
        and _only_56_result_claims(normalized)
    )


def _is_56_answer(text: str) -> bool:
    normalized = _normalized_probe_text(text)
    claims = _RESULT_CLAIM.findall(normalized)
    return _only_56_result_claims(normalized) and (bool(claims) or normalized in {"56", "五十六"})


def _result(
    gate: int,
    name: str,
    reasons: list[str],
    evidence: Iterable[str],
) -> GateResult:
    return GateResult(
        gate=gate,
        name=name,
        status="fail" if reasons else "pass",
        reason_codes=list(dict.fromkeys(reasons)),
        evidence_refs=list(dict.fromkeys(evidence)),
    )


def _progress_gate(
    events: list[ProbeEvent],
    *,
    require_provenance: bool,
    allow_interrupted: bool = False,
) -> GateResult:
    ordered = _ordered(events)
    injected = _events(ordered, "host.progress_injected")
    created = _events(ordered, "provider.item_created")
    triggers = _events(ordered, "host.response_create")
    transcripts = [
        event
        for event in _events(ordered, "assistant.transcript")
        if event.data.get("purpose") == "progress"
    ]
    spoken = _events(ordered, "host.progress_spoken")
    interrupted = _events(ordered, "host.progress_interrupted")
    reasons: list[str] = []
    evidence = [event.event_ref for event in injected + transcripts + spoken + interrupted]
    expected_spoken = (
        {"progress-2", "progress-3"}
        if allow_interrupted
        else {
            "progress-1",
            "progress-2",
            "progress-3",
        }
    )
    expected_interrupted = {"progress-1"} if allow_interrupted else set()
    spoken_ids = [str(event.data.get("progress_id")) for event in spoken]
    interrupted_ids = [str(event.data.get("progress_id")) for event in interrupted]
    if (
        len(injected) != 3
        or len(transcripts) != 3
        or Counter(spoken_ids) != Counter(expected_spoken)
        or Counter(interrupted_ids) != Counter(expected_interrupted)
    ):
        reasons.append("progress_sequence_incomplete")
    if set(spoken_ids) & set(interrupted_ids):
        reasons.append("progress_terminal_disposition_conflict")

    created_by_item = {event.provider.get("item_id"): event for event in created}
    trigger_by_progress = {str(event.data.get("progress_id")): event for event in triggers}
    transcript_by_progress = {str(event.data.get("cause_event_id")): event for event in transcripts}
    for progress in injected:
        progress_id = str(progress.data.get("progress_id"))
        item_id = progress.provider.get("item_id")
        confirmation = created_by_item.get(item_id)
        trigger = trigger_by_progress.get(progress_id)
        transcript = transcript_by_progress.get(progress_id)
        if (
            confirmation is None
            or trigger is None
            or transcript is None
            or not (progress.t_ms < confirmation.t_ms < trigger.t_ms < transcript.t_ms)
        ):
            reasons.append("progress_trigger_order_invalid")
            continue
        text = str(transcript.data.get("text", ""))
        required_terms = [str(term) for term in progress.data.get("required_terms", [])]
        if required_terms and not all(term in text for term in required_terms):
            reasons.append("progress_fact_missing")
        if _positive_user_attribution(text):
            reasons.append("progress_misattributed_to_user")
        internal_markers = [
            "<nova_progress_event",
            "</nova_progress_event>",
            str(progress.data.get("nonce", "")),
            progress.delegate_id or "",
            item_id or "",
        ]
        if any(marker and marker in text for marker in internal_markers):
            reasons.append("progress_internal_marker_leaked")

    progress_ids = [str(event.data.get("progress_id")) for event in injected]
    if len(progress_ids) != len(set(progress_ids)):
        reasons.append("progress_duplicate")

    if require_provenance:
        answers = _events(ordered, "probe.provenance_answer")
        if len(answers) != 1:
            reasons.append("provenance_answer_missing")
        else:
            text = str(answers[0].data.get("text", ""))
            evidence.append(answers[0].event_ref)
            if not _BACKGROUND_SOURCE.search(text) or _positive_user_attribution(text):
                reasons.append("provenance_answer_wrong")
            if not re.search(r"不是|并非|没有", text):
                reasons.append("provenance_user_denial_missing")
    return _result(4, "external_event_injection", reasons, evidence)


def evaluate_phase_a(events: list[ProbeEvent]) -> GateResult:
    return _progress_gate(events, require_provenance=True)


def evaluate_interruption(
    events: list[ProbeEvent], *, progress_id: str = "progress-1"
) -> GateResult:
    ordered = _ordered(events)

    def caused_by_progress(event: ProbeEvent) -> bool:
        cause = event.data.get("cause_event_id")
        return cause is None or cause == progress_id

    progress_audio = [
        event
        for event in _events(ordered, "provider.audio_delta")
        if event.data.get("purpose") == "progress" and caused_by_progress(event)
    ]
    rendered = [
        event
        for event in _events(ordered, "local.playback_rendered")
        if event.data.get("purpose") == "progress" and caused_by_progress(event)
    ]
    onset = [
        event
        for event in _events(ordered, "local.speech_onset")
        if event.data.get("purpose") == "barge_in"
    ]
    stopped = [
        event for event in _events(ordered, "local.playback_stopped") if caused_by_progress(event)
    ]
    cancel_sent = [
        event for event in _events(ordered, "host.response_cancel") if caused_by_progress(event)
    ]
    cancelled = [
        event
        for event in _events(ordered, "provider.response_cancelled")
        if event.data.get("purpose") == "progress" and caused_by_progress(event)
    ]
    barges = [
        event
        for event in _events(ordered, "provider.user_transcript")
        if event.data.get("purpose") == "barge_in"
    ]
    foreground = [
        event
        for event in _events(ordered, "assistant.transcript")
        if event.data.get("purpose") == "foreground"
    ]
    foreground_audio = [
        event
        for event in _events(ordered, "provider.audio_delta")
        if event.data.get("purpose") == "foreground"
    ]
    delegate_states = _events(ordered, "host.delegate_status")
    delegate_cancelled = _events(ordered, "host.delegate_cancelled")
    reasons: list[str] = []
    evidence = [
        *progress_audio,
        *rendered,
        *onset,
        *stopped,
        *cancel_sent,
        *cancelled,
        *barges,
        *foreground_audio,
        *foreground,
        *delegate_states,
        *delegate_cancelled,
    ]

    required_singletons = [rendered, onset, stopped, cancel_sent, cancelled, barges, foreground]
    progress_response_ids = {
        event.provider.get("response_id")
        for event in [*progress_audio, *rendered, *stopped, *cancel_sent, *cancelled]
    }
    foreground_response_ids = {
        event.provider.get("response_id") for event in [*foreground_audio, *foreground]
    }
    if (
        not progress_audio
        or not foreground_audio
        or any(len(step) != 1 for step in required_singletons)
    ):
        reasons.append("interruption_sequence_incomplete")
    else:
        sequence = [
            rendered[0],
            onset[0],
            stopped[0],
            cancel_sent[0],
            cancelled[0],
            foreground[0],
        ]
        if any(first.t_ms >= second.t_ms for first, second in zip(sequence, sequence[1:])):
            reasons.append("interruption_order_invalid")
        if barges[0].t_ms <= onset[0].t_ms:
            reasons.append("interruption_order_invalid")
        response_ids_are_canonical = (
            len(progress_response_ids) == 1
            and all(progress_response_ids)
            and len(foreground_response_ids) == 1
            and all(foreground_response_ids)
        )
        if not response_ids_are_canonical:
            reasons.append("interruption_sequence_incomplete")
        elif progress_response_ids == foreground_response_ids:
            reasons.append("interruption_sequence_incomplete")
        if not any(audio.t_ms < rendered[0].t_ms for audio in progress_audio):
            reasons.append("interruption_order_invalid")
        if not all(
            cancelled[0].t_ms < audio.t_ms < foreground[0].t_ms for audio in foreground_audio
        ):
            reasons.append("interruption_order_invalid")

    if any(int(event.data.get("rendered_after_fence_bytes", 0)) > 0 for event in stopped):
        reasons.append("post_fence_audio_rendered")

    progress_completed_after_cancel = [
        event
        for event in _events(ordered, "provider.response_done")
        if event.data.get("purpose") == "progress"
        and caused_by_progress(event)
        and any(cancel.t_ms < event.t_ms for cancel in cancel_sent)
    ]
    if progress_completed_after_cancel:
        reasons.append("response_not_cancelled")
        evidence.extend(progress_completed_after_cancel)
    if cancelled:
        status_details = cancelled[0].data.get("status_details")
        if (
            not isinstance(status_details, dict)
            or status_details.get("reason") != "client_cancelled"
        ):
            reasons.append("response_not_client_cancelled")

    if barges and not _is_multiplication_question(str(barges[0].data.get("text", ""))):
        reasons.append("barge_transcript_wrong")
    if foreground and not _is_56_answer(str(foreground[0].data.get("text", ""))):
        reasons.append("foreground_answer_wrong")
    states_after_onset = [
        event for event in delegate_states if onset and event.t_ms > onset[0].t_ms
    ]
    if (
        not states_after_onset
        or states_after_onset[-1].data.get("delegate_status") != "running"
        or any(event.data.get("delegate_status") != "running" for event in states_after_onset)
    ):
        reasons.append("delegate_not_running")
    elif foreground and states_after_onset[-1].t_ms <= foreground[0].t_ms:
        reasons.append("interruption_order_invalid")
    if delegate_cancelled:
        reasons.append("barge_in_cancelled_delegate")

    progress_transcripts = [
        event
        for event in _events(ordered, "assistant.transcript")
        if event.data.get("purpose") == "progress" and caused_by_progress(event)
    ]
    progress_response_id: str | None = None
    if len(progress_response_ids) == 1:
        candidate = next(iter(progress_response_ids))
        if candidate:
            progress_response_id = candidate
    matching_progress_transcripts = [
        event
        for event in progress_transcripts
        if progress_response_id is not None
        and event.provider.get("response_id") == progress_response_id
    ]
    mismatched_after_cancel = [
        event
        for event in progress_transcripts
        if progress_response_id is not None
        and cancel_sent
        and event.t_ms > cancel_sent[0].t_ms
        and event.provider.get("response_id") != progress_response_id
    ]
    progress_replayed_after_cancel = list(mismatched_after_cancel)
    if len(matching_progress_transcripts) > 1:
        progress_replayed_after_cancel.extend(matching_progress_transcripts)
    if progress_replayed_after_cancel:
        reasons.append("progress_replayed_after_cancel")
        evidence.extend(progress_replayed_after_cancel)

    return _result(3, "foreground_interruption", reasons, (event.event_ref for event in evidence))


def _gate_one(events: list[ProbeEvent]) -> GateResult:
    relevant = [
        *_events(events, "provider.user_transcript"),
        *_events(events, "provider.tool_call"),
        *_events(events, "provider.response_done"),
    ]
    reasons: list[str] = []
    if not _events(events, "provider.user_transcript"):
        reasons.append("user_audio_correlation_missing")
    if not _events(events, "provider.tool_call"):
        reasons.append("tool_call_correlation_missing")
    if not _events(events, "provider.response_done"):
        reasons.append("response_correlation_missing")
    for event in relevant:
        if not event.run_id or not event.delegate_id or not any(event.provider.values()):
            reasons.append("provider_runtime_identity_missing")
    return _result(1, "correlation", reasons, (event.event_ref for event in relevant))


def _gate_two(events: list[ProbeEvent]) -> GateResult:
    accepted = _events(events, "host.delegate_accepted")
    acknowledgements = [
        event
        for event in _events(events, "provider.response_done")
        if event.data.get("purpose") == "delegate_ack"
    ]
    finals = _events(events, "host.delegate_final")
    reasons: list[str] = []
    if len(accepted) != 1 or accepted[0].data.get("delegate_status") != "running":
        reasons.append("delegate_acceptance_missing")
    elif len(acknowledgements) != 1:
        reasons.append("foreground_ack_missing")
    elif not (accepted[0].t_ms < acknowledgements[0].t_ms):
        reasons.append("delegate_acceptance_blocked")
    elif finals and acknowledgements[0].t_ms >= finals[0].t_ms:
        reasons.append("delegate_lifetime_blocked_foreground")
    return _result(
        2,
        "nonblocking_delegation",
        reasons,
        (event.event_ref for event in accepted + acknowledgements + finals),
    )


def _gate_three(events: list[ProbeEvent]) -> GateResult:
    audio = [
        event
        for event in _events(events, "provider.audio_delta")
        if event.data.get("purpose") == "progress"
    ]
    barges = [
        event
        for event in _events(events, "provider.user_transcript")
        if event.data.get("purpose") == "barge_in"
    ]
    speech_starts = [
        event
        for event in _events(events, "provider.user_speech_started")
        if event.data.get("purpose") == "barge_in"
    ]
    sent = _events(events, "host.barge_in_sent")
    cancelled = [
        event
        for event in _events(events, "provider.response_cancelled")
        if event.data.get("purpose") == "progress"
    ]
    completed_progress = [
        event
        for event in _events(events, "provider.response_done")
        if event.data.get("purpose") == "progress"
        and event.data.get("cause_event_id") == "progress-1"
    ]
    foreground = [
        event
        for event in _events(events, "assistant.transcript")
        if event.data.get("purpose") == "foreground"
    ]
    reasons: list[str] = []
    terminals = cancelled[:1] or completed_progress[:1]
    if not audio or len(sent) != 1 or len(barges) != 1 or not terminals or len(foreground) != 1:
        reasons.append("barge_in_sequence_incomplete")
    else:
        if not (
            audio[0].t_ms < sent[0].t_ms < terminals[0].t_ms < foreground[0].t_ms
            and sent[0].t_ms <= barges[0].t_ms < foreground[0].t_ms
        ):
            reasons.append("barge_in_order_invalid")
        if not re.search(r"(?:五十六|56)", str(foreground[0].data.get("text", ""))):
            reasons.append("foreground_answer_wrong")
    if completed_progress and not cancelled:
        reasons.append("barge_in_did_not_stop_response")
    if _events(events, "host.delegate_cancelled"):
        reasons.append("barge_in_cancelled_delegate")
    evidence = audio[:1] + sent + speech_starts[:1] + barges + terminals + foreground
    return _result(3, "foreground_liveness", reasons, (event.event_ref for event in evidence))


def _gate_five(events: list[ProbeEvent], *, allow_interrupted: bool = False) -> GateResult:
    injected = _events(events, "host.progress_injected")
    created = [
        event
        for event in _events(events, "provider.item_created")
        if event.data.get("progress_id") is not None
    ]
    spoken = _events(events, "host.progress_spoken")
    interrupted = _events(events, "host.progress_interrupted")
    recovery_snapshots = _events(events, "host.recovery_snapshot")
    snapshots = injected + recovery_snapshots
    final_injected = _events(events, "host.final_injected")
    final_spoken = _events(events, "host.final_spoken")
    reasons: list[str] = []

    versions = [int(event.data.get("snapshot_version", -1)) for event in _ordered(snapshots)]
    if versions != sorted(set(versions)):
        reasons.append("snapshot_version_not_monotonic")
    injected_items = [event.provider.get("item_id") for event in injected]
    created_items = [event.provider.get("item_id") for event in created]
    if Counter(injected_items) != Counter(created_items):
        reasons.append("provider_item_confirmation_mismatch")
    injected_ids = [str(event.data.get("progress_id")) for event in injected]
    spoken_ids = [str(event.data.get("progress_id")) for event in spoken]
    interrupted_ids = [str(event.data.get("progress_id")) for event in interrupted]
    terminal_ids = spoken_ids + interrupted_ids
    expected_interrupted = {"progress-1"} if allow_interrupted else set()
    if (
        Counter(injected_ids) != Counter(terminal_ids)
        or len(terminal_ids) != len(set(terminal_ids))
        or set(interrupted_ids) != expected_interrupted
    ):
        reasons.append("progress_delivery_duplicate_or_missing")
    if allow_interrupted:
        if len(recovery_snapshots) != 1:
            reasons.append("recovery_progress_history_mismatch")
        else:
            recovery = recovery_snapshots[0]
            spoken_before_recovery = {
                str(event.data.get("progress_id")) for event in spoken if event.t_ms < recovery.t_ms
            }
            interrupted_before_recovery = {
                str(event.data.get("progress_id"))
                for event in interrupted
                if event.t_ms < recovery.t_ms
            }
            if (
                set(recovery.data.get("delivered_progress_ids", [])) != spoken_before_recovery
                or set(recovery.data.get("interrupted_progress_ids", []))
                != interrupted_before_recovery
            ):
                reasons.append("recovery_progress_history_mismatch")
            terminal_before_recovery = spoken_before_recovery | interrupted_before_recovery
            if any(
                event.t_ms > recovery.t_ms
                and str(event.data.get("progress_id")) in terminal_before_recovery
                for event in injected
            ):
                reasons.append("recovery_replayed_progress")
    if len(final_injected) != 1 or len(final_spoken) != 1:
        reasons.append("final_delivery_not_exactly_once")
    evidence = snapshots + spoken + interrupted + final_injected + final_spoken
    return _result(5, "bounded_synchronization", reasons, (event.event_ref for event in evidence))


def _gate_six(events: list[ProbeEvent]) -> GateResult:
    drops = _events(events, "host.connection_dropped")
    snapshots = _events(events, "host.recovery_snapshot")
    recovery_answers = [
        event
        for event in _events(events, "assistant.transcript")
        if event.data.get("purpose") == "recovery"
    ]
    finals = _events(events, "host.delegate_final")
    followups = [
        event
        for event in _events(events, "assistant.transcript")
        if event.data.get("purpose") == "context_followup"
    ]
    reasons: list[str] = []
    if len(drops) != 1 or len(snapshots) != 1 or len(recovery_answers) != 1:
        reasons.append("recovery_sequence_incomplete")
    else:
        answer = str(recovery_answers[0].data.get("text", ""))
        if not (
            drops[0].t_ms < snapshots[0].t_ms < recovery_answers[0].t_ms
            and snapshots[0].data.get("delegate_status") == "running"
            and _IN_PROGRESS.search(answer)
        ):
            reasons.append("recovery_not_honest")
        if finals and recovery_answers[0].t_ms >= finals[0].t_ms:
            reasons.append("recovery_replayed_or_invented_completion")
    if len(finals) != 1 or len(followups) != 1:
        reasons.append("post_recovery_context_missing")
    elif not (
        "俄罗斯方块" in str(followups[0].data.get("text", ""))
        and re.search(r"index\.html|单文件", str(followups[0].data.get("text", "")))
    ):
        reasons.append("post_recovery_context_wrong")
    evidence = drops + snapshots + recovery_answers + finals + followups
    return _result(6, "honest_recovery", reasons, (event.event_ref for event in evidence))


def evaluate_six_gates(
    events: list[ProbeEvent], *, strict_interruption: bool = False
) -> list[GateResult]:
    ordered = _ordered(events)
    interruption = (
        evaluate_interruption(ordered, progress_id="progress-1")
        if strict_interruption
        else _gate_three(ordered)
    )
    return [
        _gate_one(ordered),
        _gate_two(ordered),
        interruption,
        _progress_gate(
            ordered,
            require_provenance=False,
            allow_interrupted=strict_interruption,
        ),
        _gate_five(ordered, allow_interrupted=strict_interruption),
        _gate_six(ordered),
    ]
