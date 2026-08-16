from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from nova_audio_agent import calls
from nova_audio_agent.calls import WatchRecord
from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.events import Deadline, HandoffEvent, ProgressEvent, RoutingClass, WakeReason
from nova_audio_agent.executors.codex import CODEX_POLICY
from nova_audio_agent.memory import HandoffPolicy, Memory, MemoryItem, Outcome
from nova_audio_agent.ports import Delegate, ExecutorManifest, OpSpec, SurrogateOutput
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.suggestions import Suggestion


def runtime_with_suggest_policy(*, routing_class: RoutingClass, suggest: bool = True) -> Runtime:
    policy = HandoffPolicy(
        channel="watch",
        priority=40,
        wake="none",
        typical_latency=1.0,
        compress_watermark=20,
        suggest=suggest,
    )
    runtime = Runtime(clock=VirtualClock(), memory=Memory(policies=(policy,)))
    runtime.executors["watch"] = SimpleNamespace(
        manifest=ExecutorManifest(
            name="watch",
            ops=(
                OpSpec(
                    name="observe",
                    description="observe",
                    params={"type": "object", "properties": {}},
                    readonly=True,
                ),
            ),
            policy=policy,
        )
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id=f"d-{routing_class}",
            executor="watch",
            op="observe",
            request={},
            origin_ref="conversation:1",
            deadline=30.0,
            routing_class=routing_class,
            dispatched_at=0.0,
        )
    )
    return runtime


def handoff(
    *,
    delegate_id: str,
    outcome: Outcome = "ok",
    content: dict[str, object] | None = None,
) -> HandoffEvent:
    return HandoffEvent(
        channel="watch",
        delegate_id=delegate_id,
        origin_ref="conversation:1",
        outcome=outcome,
        trust="trusted_system",
        content=dict(content or {"observation": "cup"}),
    )


def test_ok_ambient_handoff_enters_pool_with_appended_evidence() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient")

    runtime.apply(handoff(delegate_id="d-ambient", content={"observation": "cup"}))

    suggestion = runtime.suggestions.get("s-1")
    assert suggestion is not None
    assert suggestion.origin == "executor"
    assert suggestion.kind == "notify"
    assert suggestion.content == {"observation": "cup"}
    assert suggestion.evidence_refs == ("watch:1",)
    assert suggestion.salience == 40.0


@pytest.mark.parametrize(
    ("routing_class", "outcome"),
    [("user_awaited", "ok"), ("ambient", "failed"), ("ambient", "unknown")],
)
def test_non_ambient_or_non_ok_handoff_does_not_enter_pool(
    routing_class: RoutingClass, outcome: Outcome
) -> None:
    runtime = runtime_with_suggest_policy(routing_class=routing_class)

    runtime.apply(handoff(delegate_id=f"d-{routing_class}", outcome=outcome))

    assert runtime.suggestions.get("s-1") is None


def test_suggest_false_handoff_only_appends_memory() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient", suggest=False)

    runtime.apply(handoff(delegate_id="d-ambient"))

    assert len(runtime.memory.channels["watch"].items) == 1
    assert runtime.suggestions.all() == ()


def test_executor_suggestion_copies_handoff_content() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient")
    event = handoff(delegate_id="d-ambient", content={"observation": "cup"})

    runtime.apply(event)
    event.content["observation"] = "plate"

    suggestion = runtime.suggestions.get("s-1")
    assert suggestion is not None
    assert suggestion.content == {"observation": "cup"}


def test_duplicate_ambient_handoff_adds_exactly_one_suggestion() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient")
    event = handoff(delegate_id="d-ambient")

    runtime._process_event(event, reclaim=True)
    runtime._process_event(event, reclaim=True)

    assert len(runtime.suggestions.all()) == 1


def test_stale_handoff_id_does_not_add_a_suggestion() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient")

    runtime._process_event(handoff(delegate_id="d-stale"), reclaim=True)

    assert len(runtime.suggestions.all()) == 0


def test_duplicate_user_awaited_handoff_never_falls_back_into_pool() -> None:
    runtime = runtime_with_suggest_policy(routing_class="user_awaited")
    event = handoff(delegate_id="d-user_awaited")

    runtime._process_event(event, reclaim=True)
    runtime._process_event(event, reclaim=True)

    assert len(runtime.suggestions.all()) == 0


def test_one_late_result_after_deadline_remains_eligible_for_the_pool() -> None:
    runtime = runtime_with_suggest_policy(routing_class="ambient")

    runtime._process_event(Deadline(delegate_id="d-ambient"), reclaim=True)
    runtime._process_event(handoff(delegate_id="d-ambient"), reclaim=True)

    assert len(runtime.suggestions.all()) == 1
    assert runtime.suggestions.all()[0].evidence_refs == ("watch:2",)


def selection_runtime(selected: list[tuple[Suggestion, WakeReason]]) -> Runtime:
    return Runtime(
        clock=VirtualClock(),
        memory=Memory(),
        on_suggestion_selected=lambda suggestion, reason: selected.append((suggestion, reason)),
    )


def selection_record(*, suggestion_id: str, offered: tuple[str, ...]) -> WatchRecord:
    return WatchRecord(
        reason=WakeReason(
            kind="handoff",
            priority=40,
            routing_class="ambient",
            origin="watch:1",
        ),
        output=SurrogateOutput(speak=True, suggestion_id=suggestion_id, reason="worth mentioning"),
        offered=offered,
    )


def test_valid_selection_calls_runtime_callback_without_firing() -> None:
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime = selection_runtime(selected)
    suggestion = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "cup"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )

    runtime._consume_watch(selection_record(suggestion_id=suggestion.id, offered=(suggestion.id,)))

    assert selected == [
        (
            suggestion,
            WakeReason(
                kind="suggestion_selected",
                priority=40,
                routing_class="ambient",
                origin="watch:1",
                selected_suggestion="s-1",
            ),
        )
    ]
    assert runtime.suggestions.get(suggestion.id) == suggestion


def test_selection_absent_from_offered_set_does_not_call_callback() -> None:
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime = selection_runtime(selected)
    suggestion = runtime.suggestions.add(
        origin="executor", kind="notify", content={"observation": "cup"}
    )

    runtime._consume_watch(selection_record(suggestion_id=suggestion.id, offered=()))

    assert selected == []


def test_selection_locked_before_consume_does_not_call_callback() -> None:
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime = selection_runtime(selected)
    suggestion = runtime.suggestions.add(
        origin="executor", kind="notify", content={"observation": "cup"}
    )
    runtime.suggestions.fire(suggestion.id, now=runtime.clock.now())

    runtime._consume_watch(selection_record(suggestion_id=suggestion.id, offered=(suggestion.id,)))

    assert selected == []


def test_runtime_confirmation_is_the_explicit_fire_path() -> None:
    runtime = Runtime(clock=VirtualClock(), memory=Memory())
    suggestion = runtime.suggestions.add(
        origin="executor", kind="notify", content={"observation": "cup"}
    )

    runtime.confirm_suggestion_spoken(suggestion.id)

    fired = runtime.suggestions.get(suggestion.id)
    assert fired is not None
    assert fired.status == "fired"


def progress_selection_runtime(
    decisions: list[calls.AttentionDecision],
    selected: list[tuple[Suggestion, WakeReason]] | None = None,
) -> tuple[Runtime, Suggestion, MemoryItem]:
    runtime = Runtime(
        clock=VirtualClock(),
        memory=Memory(policies=(CODEX_POLICY,)),
        on_suggestion_selected=(
            None
            if selected is None
            else lambda suggestion, reason: selected.append((suggestion, reason))
        ),
        on_attention_decision=decisions.append,
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-codex",
            executor="codex",
            op="run",
            request={"prompt": "inspect"},
            origin_ref="conversation:1",
            deadline=180.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    runtime.apply(
        ProgressEvent(
            channel="codex",
            delegate_id="d-codex",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=2.0,
            summary="found a useful detail",
            ts=0.0,
            seq=1,
        )
    )
    memory_item = runtime.memory.channels["codex"].items[-1]
    suggestion = runtime.suggestions.all()[-1]
    return runtime, suggestion, memory_item


def progress_watch_record(
    *,
    trigger: Suggestion,
    output: SurrogateOutput,
    offered: tuple[str, ...],
) -> WatchRecord:
    return WatchRecord(
        reason=WakeReason(
            kind=ProgressEvent.KIND,
            priority=CODEX_POLICY.priority,
            routing_class="ambient",
            origin="d-codex",
        ),
        output=output,
        offered=offered,
        trigger=progress_trigger(trigger),
    )


def progress_trigger(suggestion: Suggestion) -> calls.AttentionTrigger:
    return calls.AttentionTrigger(
        suggestion_id=suggestion.id,
        delegate_id="d-codex",
        channel="codex",
        memory_ref=suggestion.evidence_refs[0],
    )


def test_progress_speak_false_withdraws_exact_trigger_but_keeps_memory() -> None:
    decisions: list[calls.AttentionDecision] = []
    runtime, suggestion, memory_item = progress_selection_runtime(decisions)
    record = progress_watch_record(
        trigger=suggestion,
        output=SurrogateOutput(speak=False, reason="not useful now"),
        offered=(suggestion.id,),
    )

    runtime._consume_watch(record)

    assert runtime.suggestions.get(suggestion.id).status == "withdrawn"  # type: ignore[union-attr]
    assert runtime.memory.channels["codex"].items[-1] == memory_item
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=False,
            selected=False,
        )
    ]


def test_progress_exact_valid_selection_keeps_trigger_and_selects_it() -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, suggestion, memory_item = progress_selection_runtime(decisions, selected)
    record = progress_watch_record(
        trigger=suggestion,
        output=SurrogateOutput(
            speak=True,
            suggestion_id=suggestion.id,
            reason="useful now",
        ),
        offered=(suggestion.id,),
    )

    runtime._consume_watch(record)

    assert runtime.suggestions.get(suggestion.id) == suggestion
    assert runtime._latest_progress_suggestion == {}  # noqa: SLF001
    assert selected == [
        (
            suggestion,
            WakeReason(
                kind="suggestion_selected",
                priority=CODEX_POLICY.priority,
                routing_class="ambient",
                origin="d-codex",
                selected_suggestion=suggestion.id,
            ),
        )
    ]
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=True,
            selected=True,
        )
    ]


def test_progress_different_valid_selection_withdraws_trigger_and_selects_other() -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, trigger, memory_item = progress_selection_runtime(decisions, selected)
    other = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "another useful detail"},
        evidence_refs=(memory_item.ref,),
    )
    record = progress_watch_record(
        trigger=trigger,
        output=SurrogateOutput(speak=True, suggestion_id=other.id, reason="prefer other"),
        offered=(trigger.id, other.id),
    )

    runtime._consume_watch(record)

    assert runtime.suggestions.get(trigger.id).status == "withdrawn"  # type: ignore[union-attr]
    assert runtime.suggestions.get(other.id) == other
    assert selected[0][0] == other
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=True,
            selected=False,
        )
    ]


@pytest.mark.asyncio
async def test_non_progress_watch_cannot_offer_or_select_pending_progress_candidate() -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, progress, _memory_item = progress_selection_runtime(decisions, selected)
    offered: list[tuple[str, ...]] = []

    class SelectingSurrogate:
        async def watch(self, view: ContextView) -> SurrogateOutput:
            offered.append(
                tuple(item.ref for item in view.affordances if item.source == "suggestion")
            )
            return SurrogateOutput(
                speak=True,
                suggestion_id=progress.id,
                reason="select the pending progress candidate",
            )

    runtime.surrogate = SelectingSurrogate()
    runtime.wake(
        "surrogate.watch",
        WakeReason(
            kind=HandoffEvent.KIND,
            priority=90,
            routing_class="ambient",
            origin="watch:1",
        ),
    )

    await runtime.run()

    assert offered == [()]
    assert selected == []
    assert decisions == []
    assert runtime.suggestions.get(progress.id) == progress


@pytest.mark.parametrize("invalid_kind", ("invented", "unoffered"))
def test_progress_invented_or_unoffered_selection_withdraws_exact_trigger(
    invalid_kind: str,
) -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, trigger, memory_item = progress_selection_runtime(decisions, selected)
    invalid_id = "s-invented"
    if invalid_kind == "unoffered":
        invalid_id = runtime.suggestions.add(
            origin="executor",
            kind="notify",
            content={"observation": "not shown"},
        ).id
    record = progress_watch_record(
        trigger=trigger,
        output=SurrogateOutput(speak=True, suggestion_id=invalid_id, reason="bad id"),
        offered=(trigger.id,),
    )

    runtime._consume_watch(record)

    assert runtime.suggestions.get(trigger.id).status == "withdrawn"  # type: ignore[union-attr]
    assert selected == []
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=True,
            selected=False,
        )
    ]


def test_progress_unavailable_exact_selection_cannot_select_trigger() -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, trigger, memory_item = progress_selection_runtime(decisions, selected)
    runtime.suggestions.fire(trigger.id, now=runtime.clock.now())
    record = progress_watch_record(
        trigger=trigger,
        output=SurrogateOutput(speak=True, suggestion_id=trigger.id, reason="too late"),
        offered=(trigger.id,),
    )

    runtime._consume_watch(record)

    assert runtime.suggestions.get(trigger.id).status == "fired"  # type: ignore[union-attr]
    assert runtime._latest_progress_suggestion == {}  # noqa: SLF001
    assert selected == []
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=True,
            selected=False,
        )
    ]


def test_progress_superseded_old_trigger_verdict_keeps_new_candidate() -> None:
    decisions: list[calls.AttentionDecision] = []
    selected: list[tuple[Suggestion, WakeReason]] = []
    runtime, old, memory_item = progress_selection_runtime(decisions, selected)
    old_record = progress_watch_record(
        trigger=old,
        output=SurrogateOutput(speak=True, suggestion_id=old.id, reason="stale"),
        offered=(old.id,),
    )
    runtime.apply(
        ProgressEvent(
            channel="codex",
            delegate_id="d-codex",
            op="run",
            phase="working",
            internal_activity=2,
            elapsed=3.0,
            summary="newer useful detail",
            ts=1.0,
            seq=2,
        )
    )
    newer = runtime.suggestions.all()[-1]

    runtime._consume_watch(old_record)

    assert runtime.suggestions.get(old.id).status == "withdrawn"  # type: ignore[union-attr]
    assert runtime.suggestions.get(newer.id) == newer
    assert runtime._latest_progress_suggestion == {"d-codex": newer.id}  # noqa: SLF001
    assert selected == []
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=True,
            selected=False,
        )
    ]


@pytest.mark.asyncio
async def test_progress_newer_event_during_old_watch_survives_old_silent_verdict() -> None:
    decisions: list[calls.AttentionDecision] = []
    runtime, old, memory_item = progress_selection_runtime(decisions)

    class BlockingSurrogate:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def watch(self, _view: ContextView) -> SurrogateOutput:
            self.started.set()
            await self.release.wait()
            return SurrogateOutput(speak=False, reason="old verdict")

    surrogate = BlockingSurrogate()
    reason = WakeReason(
        kind=ProgressEvent.KIND,
        priority=CODEX_POLICY.priority,
        routing_class="ambient",
        origin="d-codex",
    )
    runtime.surrogate = surrogate
    runtime.wake("surrogate.watch", reason)
    await surrogate.started.wait()
    runtime.apply(
        ProgressEvent(
            channel="codex",
            delegate_id="d-codex",
            op="run",
            phase="working",
            internal_activity=2,
            elapsed=3.0,
            summary="arrived while watch was running",
            ts=1.0,
            seq=2,
        )
    )
    newer = runtime.suggestions.all()[-1]
    surrogate.release.set()

    await runtime.run()

    assert runtime.suggestions.get(newer.id) == newer
    assert runtime._latest_progress_suggestion == {"d-codex": newer.id}  # noqa: SLF001
    assert decisions == [
        calls.AttentionDecision(
            channel="codex",
            memory_ref=memory_item.ref,
            speak=False,
            selected=False,
        )
    ]


@pytest.mark.asyncio
async def test_progress_expired_candidate_spawns_watch_without_trigger() -> None:
    decisions: list[calls.AttentionDecision] = []
    runtime, suggestion, _memory_item = progress_selection_runtime(decisions)

    class SilentSurrogate:
        async def watch(self, _view: ContextView) -> SurrogateOutput:
            return SurrogateOutput(speak=False, reason="expired")

    clock = runtime.clock
    assert isinstance(clock, VirtualClock)
    clock.advance_to(suggestion.expires_at)
    runtime.surrogate = SilentSurrogate()
    runtime.wake(
        "surrogate.watch",
        WakeReason(
            kind=ProgressEvent.KIND,
            priority=CODEX_POLICY.priority,
            routing_class="ambient",
            origin="d-codex",
        ),
    )

    await runtime.run()

    assert runtime._latest_progress_suggestion == {}  # noqa: SLF001
    assert runtime.suggestions.get(suggestion.id) == suggestion
    assert decisions == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "evidence_refs",
    (("other:1",), ("codex:1", "codex:2")),
    ids=("wrong_channel", "multiple_refs"),
)
async def test_progress_invalid_evidence_spawns_watch_without_trigger(
    evidence_refs: tuple[str, ...],
) -> None:
    decisions: list[calls.AttentionDecision] = []
    runtime, _original, _memory_item = progress_selection_runtime(decisions)
    candidate = runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"summary": "invalid provenance"},
        evidence_refs=evidence_refs,
    )
    runtime._latest_progress_suggestion["d-codex"] = candidate.id  # noqa: SLF001

    class SilentSurrogate:
        async def watch(self, _view: ContextView) -> SurrogateOutput:
            return SurrogateOutput(speak=False, reason="invalid provenance")

    runtime.surrogate = SilentSurrogate()
    runtime.wake(
        "surrogate.watch",
        WakeReason(
            kind=ProgressEvent.KIND,
            priority=CODEX_POLICY.priority,
            routing_class="ambient",
            origin="d-codex",
        ),
    )

    await runtime.run()

    assert runtime.suggestions.get(candidate.id) == candidate
    assert decisions == []
