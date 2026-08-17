"""Production orchestration between a realtime FrontBrain and the existing Runtime."""

from __future__ import annotations

import asyncio
import heapq
import hashlib
import json
import math
import re
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass, field, replace
from os import environ
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from nova_audio_agent.calls import AttentionDecision
from nova_audio_agent.events import (
    Deadline,
    Event,
    HandoffEvent,
    ObservationEvent,
    ProgressEvent,
    WakeReason,
)
from nova_audio_agent.memory import USER_PRIORITY, MemoryRef, parse_ref
from nova_audio_agent.ports import ExecutorManifest, valid_progress_summary
from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge, ToolAcceptance
from nova_audio_agent.realtime.evidence import (
    final_speech_view as _final_speech_view,
    generic_final_speech_view as _generic_final_speech_view,
)
from nova_audio_agent.realtime.history import (
    RecoveryTurn,
    pack_recovery_turns,
    project_recovery_turns,
)
from nova_audio_agent.realtime.protocol import (
    HostContextItem,
    HostResponseIntent,
    ItemDeliveryUncertainError,
    ProviderErrorEvent,
    RealtimeFrontBrain,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseCancelRejected,
    ResponseStarted,
    ResponseTerminal,
    ToolCallReady,
    UserSpeechStarted,
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackGeneration
from nova_audio_agent.realtime.session import CaptionFrame, RealtimeDeliveryError, RealtimeSession
from nova_audio_agent.realtime.project_confirmation import (
    ConfirmedProjectOperation,
    ProjectConfirmationController,
    ProjectConfirmationView,
)
from nova_audio_agent.realtime.speech_prep import SPEECH_FINAL_LIMIT, prepare_for_speech
from nova_audio_agent.realtime.telemetry import RealtimeTelemetry
from nova_audio_agent.runtime import Runtime, observation_delegate
from nova_audio_agent.suggestions import Suggestion
from nova_audio_agent.tool_schema import CompiledTools

MAX_HOST_FACT_CHARS = 3000
MAX_TRACKED_TOOL_CALLS = 500
MAX_PENDING_TOOL_REFUSALS = 32
PROJECT_EXPIRY_STEP_TIMEOUT_S = 5.0
MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS = 500
MAX_TRACKED_ORIGIN_DELIVERY_PROOFS = MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
MAX_UNCERTAIN_DELIVERY_RETRIES = 256
# R105: delegates whose sync wait was resolved by a Deadline; a later handoff
# still downgrades to one host fact. Bounded, oldest dropped.
MAX_LATE_SYNC_RESULTS = 64
_SYNC_RESULT_TITLE_CHARS = 120
_SYNC_RESULT_SNIPPET_CHARS = 400
USER_HOLD_MAX_S = 30.0
STALE_DELIVERY_RETRY_S = 1.0
PREEMPT_MIN_PRIORITY = 80
GUARD_ALERT_DEADLINE_S = 0.350
GUARD_CLEAR_ACK_DEADLINE_S = 0.500
# A monitoring hit outranks routine executor announcements (codex=50) without
# reaching the preemption band; heartbeats and misses keep the manifest priority.
HIT_ALERT_MIN_PRIORITY = 55

CodexState = Literal["idle", "running"]
GuardHistoryRecovery = Literal["none", "packed"]


@dataclass(frozen=True, slots=True)
class ToolCallAcceptanceSnapshot:
    session_epoch: int
    call_id: str
    provider_response_id: str
    acceptance: ToolAcceptance


def _encode_view(view: dict[str, object]) -> str:
    return json.dumps(view, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _suggestion_speech_view(content: object) -> str:
    values = content if type(content) is dict else {}
    text = next(
        (
            value.strip()
            for key in ("observation", "summary", "message")
            if type(value := values.get(key)) is str and value.strip()
        ),
        "有一条新的提醒",
    )
    return prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)[0]


def _project_commit_failure_text(code: object) -> str:
    messages = {
        "workspace_name_conflict": "工作区名称已存在，本次操作未执行。",
        "workspace_limit": "工作区数量已达上限，本次操作未执行。",
        "session_limit": "Session 数量已达上限，本次操作未执行。",
        "state_busy": "工作区状态正忙，请稍后再试。",
        "busy": "Codex 当前正忙，本次操作未执行。",
        "runtime_rejected": "Codex 当前正忙，本次操作未执行。",
        "confirmation_invalid": "确认状态已失效，本次操作未执行。",
        "workspace_not_found": "没有找到指定工作区，本次操作未执行。",
        "session_not_found": "没有找到指定 Session，本次操作未执行。",
        "session_unavailable": "指定 Session 当前不可继续，本次操作未执行。",
    }
    return messages.get(code, "已确认，但操作未执行。")


@dataclass(slots=True)
class _ToolCallState:
    acceptance: ToolAcceptance
    provider_response_id: str
    provider_session_epoch: int
    origin_user_input_revision: int
    observation: Literal["observed", "superseded"]
    dispatch: Literal["dispatched", "fulfilled", "rejected", "not_dispatched"]
    logical_name: str | None = None
    output: Literal["pending", "confirmed"] = "pending"
    continuation: Literal["queued", "requested", "bound", "terminal", "abandoned"] = "queued"
    continuation_response_id: str | None = None
    final_disposition: Literal["completed", "superseded", "abandoned", "refused"] | None = None
    # R105: sync-result wait state. "pending" holds the batch; "resolved" carries a
    # confirmed result; "announce" downgrades the result to an ordinary host fact.
    sync: Literal["none", "pending", "resolved", "announce"] = "none"


@dataclass(slots=True)
class _ContinuationBatch:
    provider_response_id: str
    call_keys: list[tuple[int, str]]
    origin_status: Literal["active", "completed", "cancelled", "failed"] = "active"
    phase: Literal["collecting", "ready", "requested", "bound", "terminal", "abandoned"] = (
        "collecting"
    )
    continuation_response_id: str | None = None


@dataclass(slots=True)
class _SemanticAcknowledgement:
    event_id: str
    summary: str
    channel: str = "codex"
    origin_session_epoch: int | None = None
    origin_response_id: str | None = None
    origin_user_input_revision: int | None = None
    origin_delivered: bool = False
    phase: Literal["pending", "queued", "requested", "bound", "delivered"] = "pending"
    response_id: str | None = None
    binding: Literal["continuation", "fallback"] | None = None
    failed_retry_consumed: bool = False


@dataclass(frozen=True, slots=True)
class _DeferredOriginToolCall:
    event: ToolCallReady
    response_id: str
    user_item_id: str | None


@dataclass(frozen=True, slots=True)
class _ProjectExpiryBatch:
    item_keys: tuple[tuple[int, str], ...]
    source_epoch: int
    reconnect: bool


@dataclass(order=True, frozen=True, slots=True)
class _QueuedHostResponse:
    sort_key: tuple[int, int, int]
    intent: HostResponseIntent = field(compare=False)
    priority: int = field(compare=False)
    preemptive: bool = field(compare=False)
    seq: int = field(compare=False)
    queued_at: float = field(compare=False)
    semantic_event_id: str | None = field(default=None, compare=False)
    guard_activation: _GuardActivationAuthority | None = field(default=None, compare=False)


@dataclass(frozen=True, slots=True)
class _GuardActivationAuthority:
    delegate_id: str
    event_id: str
    source_epoch: int


@dataclass(frozen=True, slots=True)
class _UrgentHostResponseOwner:
    delivery_token: int
    session_epoch: int
    event_id: str
    queued: _QueuedHostResponse
    response_id: str | None = None
    generation: PlaybackGeneration | None = None


@dataclass(frozen=True, slots=True)
class _GuardPreemption:
    token: int
    session_epoch: int
    event_id: str
    old_response_id: str | None
    old_generation: PlaybackGeneration | None
    queued_at: float
    cancel_sent: bool = False
    deadline_fired: bool = False
    replacement_terminal: bool = False
    reconnect_permit_consumed: bool = False
    reconnect_disallowed: bool = False
    reconnect_aborted: bool = False


class RealtimeService:
    def __init__(
        self,
        *,
        provider: RealtimeFrontBrain,
        runtime: Runtime,
        tools: CompiledTools,
        provider_schemas: tuple[dict[str, object], ...] | None = None,
        session: RealtimeSession,
        bridge: RealtimeRuntimeBridge,
        id_factory: Callable[[], str] | None = None,
        on_provider_terminal: Callable[[PlaybackGeneration], None] | None = None,
        on_codex_state: Callable[[CodexState], None] | None = None,
        on_caption: Callable[[CaptionFrame], None] | None = None,
        telemetry: RealtimeTelemetry | None = None,
        controlled_guard_reconnect: bool = False,
        guard_history_recovery: GuardHistoryRecovery = "none",
        guard_history_pairs: int = 4,
        project_confirmation: ProjectConfirmationController | None = None,
        commit_project_operation: Callable[
            [ConfirmedProjectOperation, MemoryRef], Awaitable[object]
        ]
        | None = None,
        on_project_view: Callable[[ProjectConfirmationView], None] | None = None,
    ) -> None:
        if guard_history_recovery not in {"none", "packed"}:
            raise ValueError("unknown Guard history recovery arm")
        if guard_history_pairs not in {1, 2, 4}:
            raise ValueError("Guard history pair budget must be 1, 2, or 4")
        self._provider = provider
        self._runtime = runtime
        self._clock = runtime.clock
        self._tools = tools
        self._provider_schemas = deepcopy(
            tools.schemas if provider_schemas is None else provider_schemas
        )
        self.session = session
        self._bridge = bridge
        self._id_factory = (lambda: f"host_{uuid4().hex}") if id_factory is None else id_factory
        self._host_items: list[_QueuedHostResponse] = []
        self._host_item_seq = 0
        self._delivery_lock = asyncio.Lock()
        self._reconnect_lock = asyncio.Lock()
        self._pending_preempt_priority: int | None = None
        self._urgent_delivery_token = 0
        self._urgent_host_response_owner: _UrgentHostResponseOwner | None = None
        self._provider_epoch_needing_activation: int | None = None
        self._provider_reconnect_source_epoch: int | None = None
        self._guard_preemption_token = 0
        self._guard_preemption: _GuardPreemption | None = None
        self._guard_alert_deadline: asyncio.Task[None] | None = None
        self._guard_clear_deadlines: dict[tuple[str, int], asyncio.Task[None]] = {}
        self._controlled_guard_reconnect = controlled_guard_reconnect
        self._guard_history_recovery = guard_history_recovery
        self._guard_history_pairs = guard_history_pairs
        # CP3: serializes _drive_continuations across its two entry points
        # (provider events and the delivery loop); never held with _delivery_lock.
        self._continuation_drive_lock = asyncio.Lock()
        self._delivery_ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._unsubscribe: Callable[[], None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._connected = False
        self._provider_failed = False
        self._uncertain_delivery_retries: OrderedDict[str, None] = OrderedDict()
        self._tool_calls: OrderedDict[tuple[int, str], _ToolCallState] = OrderedDict()
        self._overflow_tool_calls: OrderedDict[tuple[int, str], _ToolCallState] = OrderedDict()
        self._awaiting_user_origin = False
        self._user_origin_preexisting_response_id: str | None = None
        self._unbound_user_origin_items: deque[str] = deque()
        self._response_user_origin_items: OrderedDict[tuple[int, str], str] = OrderedDict()
        self._user_origin_refs: OrderedDict[str, MemoryRef] = OrderedDict()
        self._origin_deferred_tool_calls: deque[_DeferredOriginToolCall] = deque()
        self._continuation_batches: OrderedDict[tuple[int, str], _ContinuationBatch] = OrderedDict()
        self._continuation_fifo: deque[tuple[int, str]] = deque()
        self._origin_delivery_proofs: OrderedDict[tuple[int, str], None] = OrderedDict()
        self._semantic_acknowledgements: OrderedDict[str, _SemanticAcknowledgement] = OrderedDict()
        self._semantic_acknowledgement_reservations = 0
        self._on_provider_terminal = on_provider_terminal or (lambda _generation: None)
        self._codex_state: CodexState = "idle"
        self._on_codex_state = on_codex_state or (lambda _state: None)
        self._trace_enabled = environ.get("NOVA_AUDIO_AGENT_REALTIME_TRACE") == "1"
        self._on_caption = on_caption
        self._telemetry = telemetry
        self._audio_started: set[str] = set()
        self._stale_hold_wake: asyncio.Task[None] | None = None
        # R103: last injected progress summary per delegate, for same-summary skip.
        self._last_progress_summary: dict[str, str] = {}
        # R105: delegate_id -> call_key for tool calls awaiting a sync result.
        self._pending_sync: dict[str, tuple[int, str]] = {}
        # R105: delegate_id -> call_key for sync waits resolved by a Deadline.
        self._late_sync: OrderedDict[str, tuple[int, str]] = OrderedDict()
        self._project_confirmation = project_confirmation
        self._commit_project_operation = commit_project_operation
        self._on_project_view = on_project_view or (lambda _view: None)
        self._project_confirmation_items: set[tuple[int, str]] = set()
        self._project_confirmation_closing_items: set[tuple[int, str]] = set()
        self._project_confirmation_responses: set[tuple[int, str]] = set()
        self._project_confirmation_closed_calls: OrderedDict[tuple[int, str], None] = OrderedDict()
        self._project_confirmation_closing_calls: set[tuple[int, str]] = set()
        self._project_confirmation_blocking = False
        self._project_confirmation_fence_pending = False
        self._project_expiry_task: asyncio.Task[None] | None = None
        self._project_expiry_batches: deque[_ProjectExpiryBatch] = deque()
        self._project_expiry_operations: set[asyncio.Task[object]] = set()
        self._unsubscribe_project_expiry = (
            project_confirmation.observe_expiry(self._project_confirmation_expired)
            if project_confirmation is not None
            else None
        )

    @property
    def codex_state(self) -> CodexState:
        return self._codex_state

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def tool_call_acceptances(self) -> tuple[ToolCallAcceptanceSnapshot, ...]:
        return tuple(
            ToolCallAcceptanceSnapshot(
                session_epoch=session_epoch,
                call_id=call_id,
                provider_response_id=state.provider_response_id,
                acceptance=state.acceptance,
            )
            for (session_epoch, call_id), state in self._tool_calls.items()
        )

    def semantic_acknowledgement_for(self, response_id: str) -> str | None:
        acknowledgement = next(
            (
                current
                for current in self._semantic_acknowledgements.values()
                if current.phase == "bound"
                and current.response_id == response_id
                and current.event_id.startswith("background:")
            ),
            None,
        )
        if acknowledgement is None:
            return None
        delegate_id = acknowledgement.event_id.removeprefix("background:")
        return delegate_id or None

    @staticmethod
    def _trace_id(value: str | None) -> str:
        """Identifier-safe short form for provider IDs in trace lines."""
        if value is None:
            return "-"
        return re.sub(r"[^A-Za-z0-9_.-]", "_", value)[:12]

    @staticmethod
    def _trace_alias(value: str) -> str:
        """Opaque alias for values that cross the desktop boundary: correlates
        equal IDs across trace lines without ever echoing client-supplied text."""
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]

    def _trace_transition(
        self,
        *,
        event_epoch: int,
        event_type: str,
        response_id: str | None,
        call_id: str | None,
    ) -> None:
        if not self._trace_enabled:
            return
        call_state = None if call_id is None else self._tool_call_state((event_epoch, call_id))
        traced_call_id = call_id
        traced_response_id = (
            call_state.provider_response_id
            if response_id is None and call_state is not None
            else response_id
        )
        batch = (
            None
            if traced_response_id is None
            else self._continuation_batches.get((event_epoch, traced_response_id))
        )
        if batch is None and traced_response_id is not None:
            batch = next(
                (
                    candidate
                    for batch_key, candidate in self._continuation_batches.items()
                    if batch_key[0] == event_epoch
                    and candidate.continuation_response_id == traced_response_id
                ),
                None,
            )
        if call_state is None and batch is not None:
            for batch_call_key in batch.call_keys:
                candidate = self._tool_call_state(batch_call_key)
                if candidate is not None:
                    traced_call_id = batch_call_key[1]
                    call_state = candidate
                    break
        generation = self.session.current_generation
        active_provider = self.session.active_provider_response_id
        print(
            "[realtime-trace] "
            f"epoch={event_epoch} "
            f"event={event_type} "
            f"response={self._trace_id(traced_response_id)} "
            f"call={self._trace_id(traced_call_id)} "
            "provider_phase="
            f"{self.session.provider_turn_phase(traced_response_id) or '-'} "
            f"batch_phase={'-' if batch is None else batch.phase} "
            f"tool_output={'-' if call_state is None else call_state.output} "
            f"continuation={'-' if call_state is None else call_state.continuation} "
            f"active_provider={self._trace_id(active_provider)} "
            "renderer_response="
            f"{self._trace_id(None if generation is None else generation.response_id)} "
            "renderer_generation="
            f"{'-' if generation is None else generation.generation_epoch} "
            f"floor={self.session.floor.state} "
            f"continuation_queue={len(self._continuation_fifo)} "
            f"host_queue={len(self._host_items)}",
            flush=True,
        )

    async def connect(self) -> None:
        if self._connected:
            return
        await self.session.connect(tools=deepcopy(self._provider_schemas))
        self._unsubscribe = self._runtime.observe(self.project_runtime_event)
        self._connected = True

    async def start(self) -> None:
        await self.connect()
        if self._tasks:
            return
        self._stop.clear()
        self._tasks = {
            asyncio.create_task(self._receive_loop()),
            asyncio.create_task(self._delivery_loop()),
            asyncio.create_task(self._runtime.serve(self._stop)),
        }
        for task in self._tasks:
            task.add_done_callback(self._task_finished)

    async def close(self) -> None:
        self._stop.set()
        self._invalidate_project_confirmation("service_closed")
        if self._unsubscribe_project_expiry is not None:
            self._unsubscribe_project_expiry()
            self._unsubscribe_project_expiry = None
        self._provider_epoch_needing_activation = None
        self._provider_reconnect_source_epoch = None
        self._urgent_host_response_owner = None
        guard_task = self._clear_guard_preemption()
        clear_tasks = tuple(self._guard_clear_deadlines.values())
        self._guard_clear_deadlines.clear()
        self._delivery_ready.set()
        wake, self._stale_hold_wake = self._stale_hold_wake, None
        if wake is not None:
            wake.cancel()
        project_expiry, self._project_expiry_task = self._project_expiry_task, None
        project_expiry_operations = tuple(self._project_expiry_operations)
        self._project_expiry_operations.clear()
        self._project_expiry_batches.clear()
        if project_expiry is not None:
            project_expiry.cancel()
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        close_failure: BaseException | None = None
        try:
            await self._provider.close()
        except BaseException as exc:
            close_failure = exc
        tasks, self._tasks = tuple(self._tasks), set()
        if guard_task is not None:
            tasks += (guard_task,)
        if project_expiry is not None:
            tasks += (project_expiry,)
        tasks += project_expiry_operations
        tasks += clear_tasks
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._connected = False
        if close_failure is not None:
            raise close_failure

    async def send_audio(self, pcm: bytes) -> None:
        await self._provider.send_audio(pcm)

    async def local_speech_onset(self, speech_id: str) -> None:
        floor_before = self.session.floor.state
        preemption = self._guard_preemption
        if preemption is not None:
            self._guard_preemption = replace(
                preemption,
                reconnect_disallowed=not preemption.reconnect_permit_consumed,
                reconnect_aborted=preemption.reconnect_permit_consumed,
            )
        guard_waiting_for_delivery = (
            self._guard_preemption is not None and self._urgent_host_response_owner is None
        )
        await self.session.local_speech_onset(speech_id)
        if not guard_waiting_for_delivery:
            self._clear_guard_preemption()
        self._retire_fenced_prestart_urgent()
        if self._trace_enabled:
            generation = self.session.current_generation
            active_provider = self.session.active_provider_response_id
            print(
                "[realtime-trace] "
                f"epoch={self.session.session_epoch} "
                "event=LocalSpeechOnset "
                # speech_id crosses the desktop boundary unsanitized; trace an
                # opaque alias so client-supplied text never reaches the log.
                f"speech={self._trace_alias(speech_id)} "
                f"floor_before={floor_before} "
                f"floor={self.session.floor.state} "
                f"active_provider={self._trace_id(active_provider)} "
                "renderer_response="
                f"{self._trace_id(None if generation is None else generation.response_id)} "
                "renderer_generation="
                f"{'-' if generation is None else generation.generation_epoch}",
                flush=True,
            )

    def playback_started(self, utterance_id: str, generation_epoch: int) -> bool:
        generation = self.session.current_generation
        started = self.session.playback_started(utterance_id, generation_epoch)
        if (
            started
            and generation is not None
            and generation.utterance_id == utterance_id
            and generation.generation_epoch == generation_epoch
            and self._telemetry is not None
        ):
            attribution = self._playback_attribution(generation.response_id)
            if attribution is not None:
                self._telemetry.record("playback.attribution", attribution)
        return started

    def _playback_attribution(self, response_id: str) -> dict[str, object] | None:
        suggestion_events = tuple(
            event_id
            for event_id in self.session.response_event_ids(response_id)
            if event_id.startswith("suggestion:")
        )
        if len(suggestion_events) == 1:
            suggestion = self._runtime.suggestions.get(
                suggestion_events[0].removeprefix("suggestion:")
            )
            if suggestion is not None and self._is_selected_progress(suggestion):
                memory_ref = suggestion.evidence_refs[0]
                return {"target": "selected_progress", "memory_ref": memory_ref}
        if any(
            state.logical_name == "memory.recall"
            and state.acceptance.inline_fulfilled
            and state.continuation_response_id == response_id
            for state in self._tool_calls.values()
        ):
            return {"target": "memory_recall"}
        return None

    def playback_done(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        generation = self.session.current_generation
        urgent_owner = self._urgent_owner_for_generation(utterance_id, generation_epoch)
        event_ids = (
            () if generation is None else self.session.response_event_ids(generation.response_id)
        )
        completion = self.session.complete_playback(utterance_id, generation_epoch, played_ms)
        if completion is not None:
            self._record_origin_delivery_proof(completion)
            self._cancel_guard_clear_deadline(utterance_id, generation_epoch)
            for event_id in event_ids:
                if event_id.startswith("suggestion:") and self.session.event_was_spoken(event_id):
                    self._runtime.confirm_suggestion_spoken(event_id.removeprefix("suggestion:"))
            self._release_urgent_host_response(urgent_owner)
            self._delivery_ready.set()
        return completion is not None

    def _record_origin_delivery_proof(self, completion: PlaybackCompletion) -> None:
        audible = (
            completion.played_ms > 0 if completion.played_ms is not None else completion.started
        )
        if completion.disposition != "spoken" or not audible:
            return
        key = (completion.session_epoch, completion.response_id)
        if not self._origin_can_reference_proof(key):
            return
        self._origin_delivery_proofs[key] = None
        self._origin_delivery_proofs.move_to_end(key)
        self._prune_origin_delivery_proofs()

    def _origin_can_reference_proof(self, key: tuple[int, str]) -> bool:
        session_epoch, response_id = key
        return (
            any(
                deferred.event.session_epoch == session_epoch
                and deferred.response_id == response_id
                for deferred in self._origin_deferred_tool_calls
            )
            or any(
                state.provider_session_epoch == session_epoch
                and state.provider_response_id == response_id
                for ledger in (self._tool_calls, self._overflow_tool_calls)
                for state in ledger.values()
            )
            or key in self._continuation_batches
            or any(
                acknowledgement.origin_session_epoch == session_epoch
                and acknowledgement.origin_response_id == response_id
                for acknowledgement in self._semantic_acknowledgements.values()
            )
        )

    def _origin_has_nonterminal_reference(self, key: tuple[int, str]) -> bool:
        session_epoch, response_id = key
        batch = self._continuation_batches.get(key)
        return (
            any(
                deferred.event.session_epoch == session_epoch
                and deferred.response_id == response_id
                for deferred in self._origin_deferred_tool_calls
            )
            or any(
                state.provider_session_epoch == session_epoch
                and state.provider_response_id == response_id
                and state.final_disposition is None
                for ledger in (self._tool_calls, self._overflow_tool_calls)
                for state in ledger.values()
            )
            or (batch is not None and batch.phase not in {"terminal", "abandoned"})
            or any(
                acknowledgement.origin_session_epoch == session_epoch
                and acknowledgement.origin_response_id == response_id
                and acknowledgement.phase != "delivered"
                for acknowledgement in self._semantic_acknowledgements.values()
            )
        )

    def _prune_origin_delivery_proofs(self) -> None:
        while len(self._origin_delivery_proofs) > MAX_TRACKED_ORIGIN_DELIVERY_PROOFS:
            evictable = next(
                (
                    key
                    for key in self._origin_delivery_proofs
                    if not self._origin_has_nonterminal_reference(key)
                ),
                None,
            )
            if evictable is None:
                self._origin_delivery_proofs.popitem(last=True)
                return
            del self._origin_delivery_proofs[evictable]

    def on_suggestion_selected(self, suggestion: Suggestion, reason: WakeReason) -> None:
        # R128: pool admission already requires an ok handoff; a selected hit
        # inherits R127's alert band here, at the projection layer — the wake
        # priority itself is never escalated (R36).
        hit = type(suggestion.content) is dict and suggestion.content.get("hit") is True
        speech_view = _suggestion_speech_view(suggestion.content)
        if self._is_selected_progress(suggestion):
            item = HostContextItem.progress(
                host_item_id=self._id_factory(),
                event_id=f"suggestion:{suggestion.id}",
                content=speech_view,
            )
        else:
            item = HostContextItem.final(
                host_item_id=self._id_factory(),
                event_id=f"suggestion:{suggestion.id}",
                content=speech_view,
            )
        self._queue_host_item(
            HostResponseIntent.host_fact(item),
            priority=max(reason.priority, HIT_ALERT_MIN_PRIORITY) if hit else reason.priority,
            preemptive=False,
        )

    def _is_selected_progress(self, suggestion: Suggestion) -> bool:
        if len(suggestion.evidence_refs) != 1 or type(suggestion.content) is not dict:
            return False
        summary = suggestion.content.get("summary")
        if type(summary) is not str:
            return False
        memory_ref = suggestion.evidence_refs[0]
        try:
            channel_name, seq = parse_ref(memory_ref)
        except ValueError:
            return False
        policy = self._runtime.memory.policies.get(channel_name)
        channel = self._runtime.memory.channels.get(channel_name)
        if (
            policy is None
            or not policy.progress_via_surrogate
            or channel is None
            or not 1 <= seq <= len(channel.items)
        ):
            return False
        evidence = channel.items[seq - 1]
        return (
            evidence.ref == memory_ref
            and evidence.content.get("phase") == "working"
            and evidence.content.get("summary") == summary
        )

    def on_attention_decision(self, decision: AttentionDecision) -> None:
        if self._telemetry is None:
            return
        self._telemetry.record(
            "attention.decision",
            {
                "channel": decision.channel,
                "memory_ref": decision.memory_ref,
                "speak": decision.speak,
                "selected": decision.selected,
            },
        )

    def playback_cleared(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        urgent_owner = self._urgent_owner_for_generation(utterance_id, generation_epoch)
        cleared = self.session.playback_cleared(utterance_id, generation_epoch, played_ms)
        if cleared:
            self._cancel_guard_clear_deadline(utterance_id, generation_epoch)
            self._release_urgent_host_response(urgent_owner)
            self._delivery_ready.set()
        return cleared

    async def playback_stopped(
        self,
        utterance_id: str,
        generation_epoch: int,
        played_ms: int | None = None,
    ) -> bool:
        urgent_owner = self._urgent_owner_for_generation(utterance_id, generation_epoch)
        stopped = await self.session.playback_stopped(utterance_id, generation_epoch, played_ms)
        if stopped:
            self._cancel_guard_clear_deadline(utterance_id, generation_epoch)
            self._release_urgent_host_response(urgent_owner)
            self._delivery_ready.set()
        return stopped

    async def wait_stopped(self) -> None:
        await self._stop.wait()

    async def handle_event(self, event: RealtimeFrontBrainEvent) -> None:
        response_id = getattr(event, "response_id", None)
        call_id = event.call_id if isinstance(event, ToolCallReady) else None
        if isinstance(event, ResponseCancelRejected):
            await self._handle_guard_cancel_rejected(event)
            self._trace_transition(
                event_epoch=event.session_epoch,
                event_type=type(event).__name__,
                response_id=response_id,
                call_id=call_id,
            )
            return
        if isinstance(event, ProviderErrorEvent):
            print(
                "[realtime-diagnostic] provider_error "
                f"code={event.code} recoverable={event.recoverable}",
                flush=True,
            )
            if event.recoverable:
                await self._reconnect_provider_session()
                self._clear_captions()
            else:
                self._provider_failed = True
                self._urgent_host_response_owner = None
                self._clear_guard_preemption()
                self._stop.set()
            self._trace_transition(
                event_epoch=event.session_epoch,
                event_type=type(event).__name__,
                response_id=response_id,
                call_id=call_id,
            )
            return

        if self._telemetry is not None:
            if isinstance(event, ResponseStarted):
                self._telemetry.record(
                    "provider.response_started", {"response_id": event.response_id}
                )
            elif isinstance(event, ResponseAudioDelta):
                if event.response_id not in self._audio_started:
                    self._audio_started.add(event.response_id)
                    self._telemetry.record(
                        "provider.first_audio_delta", {"response_id": event.response_id}
                    )
            elif isinstance(event, ResponseTerminal):
                self._audio_started.discard(event.response_id)
        terminal_owner = (
            self._urgent_owner_for_response(event.session_epoch, event.response_id)
            if isinstance(event, ResponseTerminal)
            else None
        )
        blocked_confirmation_tool = isinstance(
            event, ToolCallReady
        ) and self._blocks_project_confirmation_tool(event)
        if blocked_confirmation_tool:
            accepted = False
        else:
            accepted = await self.session.accept(event)
        if isinstance(event, ResponseStarted) and self._project_confirmation_blocking:
            self._project_confirmation_responses.add((event.session_epoch, event.response_id))
            self._project_confirmation_fence_pending = False
            self._project_confirmation_blocking = bool(
                self._project_confirmation_items or self._project_confirmation_closing_items
            )
        if isinstance(event, (ResponseStarted, ResponseAudioDelta)):
            preemption = self._guard_preemption
            if (
                preemption is not None
                and preemption.session_epoch == event.session_epoch
                and preemption.old_response_id is None
                and self.session.active_provider_response_id == event.response_id
                and self.session.provider_turn_phase(event.response_id) == "cancel_requested"
                and self.session.provider_turn_was_fenced(event.response_id)
            ):
                self._guard_preemption = replace(
                    preemption,
                    old_response_id=event.response_id,
                )
            self._record_guard_cancel_sent(event.response_id)
        self._retire_fenced_prestart_urgent()
        if accepted and isinstance(event, (ResponseStarted, ResponseAudioDelta)):
            self._bind_urgent_host_response(event)
            self._finish_guard_first_audio(event)
        if isinstance(event, ResponseStarted) and accepted:
            if not self.session.response_event_ids(event.response_id):
                self._bind_response_user_origin(event.response_id)
            self._bind_requested_semantic_acknowledgement(event.response_id)
            self._bind_continuation(event.response_id)
        if self._on_caption is not None:
            caption = self.session.caption_for(
                event,
                accepted=accepted if isinstance(event, UserTranscriptFinal) else None,
            )
            if caption is not None:
                self._on_caption(caption)
        if isinstance(event, UserSpeechStarted) and accepted:
            if self._provider_epoch_needing_activation == event.session_epoch:
                self._provider_epoch_needing_activation = None
            self._provider_reconnect_source_epoch = None
            preemption = self._guard_preemption
            if preemption is not None:
                self._guard_preemption = replace(
                    preemption,
                    reconnect_disallowed=not preemption.reconnect_permit_consumed,
                    reconnect_aborted=preemption.reconnect_permit_consumed,
                )
            # Qwen may finish its function call before emitting this turn's
            # transcript final. Do not let that call bind to provider-authored
            # placeholder text or the previous user turn.
            self._awaiting_user_origin = True
            self._user_origin_preexisting_response_id = self.session.active_provider_response_id
            if event.provider_item_id is not None:
                self._remember_unbound_user_origin(event.provider_item_id)
            self._reserve_project_confirmation(event)
        if isinstance(event, ResponseTerminal) and accepted:
            self._record_guard_cancel_terminal(event)
            generation = self.session.current_generation
            if (
                generation is not None
                and generation.session_epoch == event.session_epoch
                and generation.response_id == event.response_id
            ):
                self._on_provider_terminal(generation)
        if isinstance(event, ResponseTerminal) and accepted:
            self._finish_semantic_acknowledgement(event)
            if event.status == "completed":
                self._reopen_failed_semantic_acknowledgements()
            self._finish_continuation(event)
            self._finish_origin(event.response_id)
            generation = self.session.current_generation
            if (
                generation is None
                or generation.session_epoch != event.session_epoch
                or generation.response_id != event.response_id
            ):
                self._release_urgent_host_response(terminal_owner)
            self._mark_guard_replacement_terminal(terminal_owner)
        if isinstance(event, UserTranscriptFinal):
            if accepted:
                if self._provider_epoch_needing_activation == event.session_epoch:
                    self._provider_epoch_needing_activation = None
                self._provider_reconnect_source_epoch = None
                origin_ref = await self._bridge.accept_user_transcript(event.text)
                self._remember_user_origin_ref(event.item_id, origin_ref)
                self._awaiting_user_origin = bool(self._unbound_user_origin_items)
                if not self._awaiting_user_origin:
                    self._user_origin_preexisting_response_id = None
                if self._is_project_confirmation_item(event.session_epoch, event.item_id):
                    await self._finish_project_confirmation(event, origin_ref)
                else:
                    await self._release_deferred_origin_calls(event.item_id, origin_ref)
        elif isinstance(event, UserTranscriptFailed):
            if accepted:
                try:
                    self._unbound_user_origin_items.remove(event.item_id)
                except ValueError:
                    pass
                for key, item_id in tuple(self._response_user_origin_items.items()):
                    if item_id == event.item_id:
                        del self._response_user_origin_items[key]
                self._awaiting_user_origin = bool(self._unbound_user_origin_items)
                if not self._awaiting_user_origin:
                    self._user_origin_preexisting_response_id = None
                if self._is_project_confirmation_item(event.session_epoch, event.item_id):
                    await self._fail_project_confirmation(event.session_epoch, event.item_id)
                else:
                    await self._release_deferred_origin_calls(event.item_id, None)
        elif isinstance(event, ToolCallReady):
            if not accepted:
                if blocked_confirmation_tool:
                    await self._close_project_confirmation_tool(event)
                self._trace_transition(
                    event_epoch=event.session_epoch,
                    event_type=type(event).__name__,
                    response_id=response_id,
                    call_id=call_id,
                )
                return
            active_response_id = self.session.active_provider_response_id
            observed_response_id = event.response_id or active_response_id
            origin_item_id = self._response_user_origin_items.get(
                (event.session_epoch, observed_response_id)
            )
            if origin_item_id is not None:
                origin_ref = self._user_origin_refs.get(origin_item_id)
                if origin_ref is not None:
                    await self._handle_tool_call(
                        event,
                        observed_provider_response_id=observed_response_id,
                        origin_ref=origin_ref,
                    )
                elif len(self._origin_deferred_tool_calls) >= MAX_PENDING_TOOL_REFUSALS:
                    await self._reconnect_provider_session()
                else:
                    self._origin_deferred_tool_calls.append(
                        _DeferredOriginToolCall(
                            event=event,
                            response_id=observed_response_id,
                            user_item_id=origin_item_id,
                        )
                    )
            elif self._awaiting_user_origin:
                origin_is_active = (
                    observed_response_id is not None
                    and active_response_id == observed_response_id
                    and self.session.provider_turn_phase(observed_response_id) == "active"
                    and not self.session.provider_turn_was_fenced(observed_response_id)
                )
                if observed_response_id == self._user_origin_preexisting_response_id:
                    await self._handle_tool_call(event)
                elif not origin_is_active:
                    await self._handle_tool_call(event)
                elif len(self._origin_deferred_tool_calls) >= MAX_PENDING_TOOL_REFUSALS:
                    await self._reconnect_provider_session()
                else:
                    self._origin_deferred_tool_calls.append(
                        _DeferredOriginToolCall(
                            event=event,
                            response_id=observed_response_id,
                            user_item_id=None,
                        )
                    )
            else:
                await self._handle_tool_call(event)
        if isinstance(event, ResponseTerminal):
            self._project_confirmation_responses.discard((event.session_epoch, event.response_id))
        if accepted:
            await self._drive_continuations()
        await self._delivery_pass()
        self._trace_transition(
            event_epoch=event.session_epoch,
            event_type=type(event).__name__,
            response_id=response_id,
            call_id=call_id,
        )

    def _remember_unbound_user_origin(self, item_id: str) -> None:
        if item_id in self._unbound_user_origin_items or item_id in self._user_origin_refs:
            return
        if item_id in self._response_user_origin_items.values():
            return
        self._unbound_user_origin_items.append(item_id)
        while len(self._unbound_user_origin_items) > MAX_PENDING_TOOL_REFUSALS:
            self._unbound_user_origin_items.popleft()

    def _reserve_project_confirmation(self, event: UserSpeechStarted) -> None:
        controller = self._project_confirmation
        if controller is None or not controller.pending:
            return
        item_id = event.provider_item_id
        if item_id is None:
            self._invalidate_project_confirmation("missing_item_correlation")
            self._queue_project_confirmation_fact("缺少语音确认关联，本次操作已取消。")
            return
        if not controller.reserve_user_item(epoch=event.session_epoch, item_id=item_id):
            return
        self._project_confirmation_items.add((event.session_epoch, item_id))
        self._project_confirmation_blocking = True
        self._project_confirmation_fence_pending = True
        self.session.arm_next_response_fence()
        self._publish_project_view()

    def _blocks_project_confirmation_tool(self, event: ToolCallReady) -> bool:
        if any(
            epoch == event.session_epoch
            for epoch, _response_id in self._project_confirmation_responses
        ):
            return True
        effective_response_id = event.response_id or self.session.active_provider_response_id
        if (
            effective_response_id is not None
            and (
                event.session_epoch,
                effective_response_id,
            )
            in self._project_confirmation_responses
        ):
            return True
        if self._project_confirmation_blocking:
            if event.response_id is not None:
                self._project_confirmation_responses.add((event.session_epoch, event.response_id))
            return True
        return False

    def _is_project_confirmation_item(self, epoch: int, item_id: str) -> bool:
        key = (epoch, item_id)
        return key in self._project_confirmation_items or key in (
            self._project_confirmation_closing_items
        )

    def _begin_project_confirmation_close(self, epoch: int, item_id: str) -> None:
        key = (epoch, item_id)
        self._project_confirmation_items.discard(key)
        self._project_confirmation_closing_items.add(key)
        self._project_confirmation_blocking = True

    def _end_project_confirmation_close(self, epoch: int, item_id: str) -> None:
        self._project_confirmation_closing_items.discard((epoch, item_id))
        self._project_confirmation_blocking = (
            bool(self._project_confirmation_items or self._project_confirmation_closing_items)
            or self._project_confirmation_fence_pending
        )

    async def _finish_project_confirmation(
        self,
        event: UserTranscriptFinal,
        origin_ref: MemoryRef,
    ) -> None:
        key = (event.session_epoch, event.item_id)
        if key in self._project_confirmation_closing_items:
            await self._close_confirmation_deferred_calls(event.item_id)
            return
        self._begin_project_confirmation_close(event.session_epoch, event.item_id)
        try:
            await self._close_confirmation_deferred_calls(event.item_id)
        finally:
            self._end_project_confirmation_close(event.session_epoch, event.item_id)
        controller = self._project_confirmation
        if controller is None:
            return
        outcome = controller.accept_transcript(
            epoch=event.session_epoch,
            item_id=event.item_id,
            text=event.text,
        )
        text = outcome.response_text
        if outcome.kind == "confirmed" and outcome.operation is not None:
            callback = self._commit_project_operation
            if callback is None:
                text = "确认处理不可用，本次操作未执行。"
            else:
                try:
                    result = await callback(outcome.operation, origin_ref)
                    accepted = getattr(result, "accepted", False) is True
                    code = getattr(result, "code", "commit_failed")
                    text = "已确认，正在处理。" if accepted else _project_commit_failure_text(code)
                except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
                    raise
                except Exception:
                    text = "已确认，但操作未执行。"
        if text:
            self._queue_project_confirmation_fact(text)
        self._publish_project_view()

    async def _fail_project_confirmation(self, epoch: int, item_id: str) -> None:
        if (epoch, item_id) in self._project_confirmation_closing_items:
            await self._close_confirmation_deferred_calls(item_id)
            return
        self._begin_project_confirmation_close(epoch, item_id)
        try:
            await self._close_confirmation_deferred_calls(item_id)
        finally:
            self._end_project_confirmation_close(epoch, item_id)
        controller = self._project_confirmation
        if controller is None:
            return
        outcome = controller.fail_transcript(epoch=epoch, item_id=item_id)
        if outcome.response_text:
            self._queue_project_confirmation_fact(outcome.response_text)
        self._publish_project_view()

    async def _close_project_confirmation_tool(self, event: ToolCallReady) -> None:
        key = (event.session_epoch, event.call_id)
        if (
            key in self._project_confirmation_closing_calls
            or key in self._project_confirmation_closed_calls
        ):
            return
        # Reserve before the first await. Expiry cleanup and provider events can
        # otherwise both inject a terminal output for the same function call.
        self._project_confirmation_closing_calls.add(key)
        token = self._id_factory()
        item = HostContextItem.tool_output(
            host_item_id=token,
            event_id=self._id_factory(),
            call_id=event.call_id,
            content='{"code":"confirmation_reserved","state":"superseded"}',
        )
        try:
            await self.session.inject_tool_output(item)
        except BaseException:
            self._project_confirmation_closing_calls.discard(key)
            raise
        self._project_confirmation_closing_calls.discard(key)
        self._project_confirmation_closed_calls[key] = None
        self._project_confirmation_closed_calls.move_to_end(key)
        while len(self._project_confirmation_closed_calls) > MAX_TRACKED_TOOL_CALLS:
            self._project_confirmation_closed_calls.popitem(last=False)

    async def _close_confirmation_deferred_calls(self, item_id: str) -> None:
        # Detach the matching entries before awaiting provider I/O. Rebuilding
        # from an old snapshot after the await would overwrite calls appended by
        # a concurrent provider event.
        matching: list[_DeferredOriginToolCall] = []
        retained: deque[_DeferredOriginToolCall] = deque()
        while self._origin_deferred_tool_calls:
            call = self._origin_deferred_tool_calls.popleft()
            (matching if call.user_item_id == item_id else retained).append(call)
        self._origin_deferred_tool_calls = retained
        for call in matching:
            await self._close_project_confirmation_tool(call.event)

    def _queue_project_confirmation_fact(self, text: str) -> None:
        item = HostContextItem.final(
            host_item_id=self._id_factory(),
            event_id=f"project-confirmation:{self._id_factory()}",
            content=text[:MAX_HOST_FACT_CHARS],
        )
        self._queue_host_item(
            HostResponseIntent.host_fact(item),
            priority=USER_PRIORITY - 1,
            preemptive=False,
        )
        self._delivery_ready.set()

    def _project_confirmation_expired(self) -> None:
        item_keys = tuple(self._project_confirmation_items)
        source_epoch = self.session.session_epoch
        reconnect = self._project_confirmation_fence_pending or any(
            epoch == source_epoch for epoch, _response_id in self._project_confirmation_responses
        )
        for epoch, item_id in item_keys:
            self._begin_project_confirmation_close(epoch, item_id)
        self._project_expiry_batches.append(
            _ProjectExpiryBatch(
                item_keys=item_keys,
                source_epoch=source_epoch,
                reconnect=reconnect,
            )
        )
        current = self._project_expiry_task
        if current is None or current.done():
            task = asyncio.create_task(self._drain_project_confirmation_expiries())
            self._project_expiry_task = task
            task.add_done_callback(self._project_expiry_finished)
        self._publish_project_view()

    async def _drain_project_confirmation_expiries(self) -> None:
        try:
            while self._project_expiry_batches:
                batch = self._project_expiry_batches.popleft()
                await self._finish_project_confirmation_expiry(batch)
        finally:
            if self._project_expiry_task is asyncio.current_task():
                self._project_expiry_task = None

    async def _finish_project_confirmation_expiry(
        self,
        batch: _ProjectExpiryBatch,
    ) -> None:
        close_failed = False
        while True:
            deferred_calls = self._take_confirmation_deferred_calls(batch.source_epoch)
            if not deferred_calls:
                break
            for deferred in deferred_calls:
                try:
                    completed = await self._run_project_expiry_step(
                        self._close_project_confirmation_tool(deferred.event)
                    )
                    close_failed = close_failed or not completed
                except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
                    raise
                except Exception:
                    close_failed = True
        if batch.reconnect or close_failed:
            try:
                await self._run_project_expiry_step(
                    self._reconnect_provider_session(expected_epoch=batch.source_epoch)
                )
            except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
                raise
            except Exception as failure:
                print(
                    "[realtime-diagnostic] project_expiry_reconnect_failure "
                    f"type={type(failure).__name__}",
                    flush=True,
                )
        for epoch, item_id in batch.item_keys:
            self._end_project_confirmation_close(epoch, item_id)
        self._queue_project_confirmation_fact("确认已过期，本次操作已取消。")
        try:
            await self._run_project_expiry_step(self._delivery_pass())
        except (asyncio.CancelledError, KeyboardInterrupt, SystemExit):
            raise
        except Exception as failure:
            print(
                "[realtime-diagnostic] project_expiry_delivery_failure "
                f"type={type(failure).__name__}",
                flush=True,
            )
        self._publish_project_view()

    def _take_confirmation_deferred_calls(
        self, source_epoch: int
    ) -> tuple[_DeferredOriginToolCall, ...]:
        matching: list[_DeferredOriginToolCall] = []
        retained: deque[_DeferredOriginToolCall] = deque()
        while self._origin_deferred_tool_calls:
            deferred = self._origin_deferred_tool_calls.popleft()
            (matching if deferred.event.session_epoch == source_epoch else retained).append(
                deferred
            )
        self._origin_deferred_tool_calls = retained
        return tuple(matching)

    async def _run_project_expiry_step(self, awaitable: Awaitable[object]) -> bool:
        operation = asyncio.create_task(awaitable)
        deadline = asyncio.create_task(self._clock.sleep(PROJECT_EXPIRY_STEP_TIMEOUT_S))
        self._project_expiry_operations.add(operation)
        operation.add_done_callback(self._project_expiry_operation_finished)
        try:
            done, _pending = await asyncio.wait(
                (operation, deadline), return_when=asyncio.FIRST_COMPLETED
            )
        except BaseException:
            operation.cancel()
            deadline.cancel()
            raise
        if operation in done:
            deadline.cancel()
            await asyncio.gather(deadline, return_exceptions=True)
            operation.result()
            return True
        operation.cancel()
        return False

    def _project_expiry_operation_finished(self, task: asyncio.Task[object]) -> None:
        self._project_expiry_operations.discard(task)
        if task.cancelled():
            return
        try:
            task.exception()
        except BaseException:
            pass

    @staticmethod
    def _project_expiry_finished(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        failure = task.exception()
        if failure is not None:
            print(
                f"[realtime-diagnostic] project_expiry_failure type={type(failure).__name__}",
                flush=True,
            )

    def _publish_project_view(self) -> None:
        controller = self._project_confirmation
        if controller is None:
            return
        try:
            self._on_project_view(controller.view)
        except Exception:
            pass

    def _invalidate_project_confirmation(self, reason: str) -> None:
        controller = self._project_confirmation
        if controller is not None:
            controller.invalidate(reason)
        self._project_confirmation_items.clear()
        self._project_confirmation_closing_items.clear()
        self._project_confirmation_responses.clear()
        self._project_confirmation_blocking = False
        self._project_confirmation_fence_pending = False
        self._publish_project_view()

    def _bind_response_user_origin(self, response_id: str) -> None:
        if not self._unbound_user_origin_items:
            return
        key = (self.session.session_epoch, response_id)
        if key in self._response_user_origin_items:
            return
        self._response_user_origin_items[key] = self._unbound_user_origin_items.popleft()
        self._awaiting_user_origin = bool(self._unbound_user_origin_items)
        if not self._awaiting_user_origin:
            self._user_origin_preexisting_response_id = None
        while len(self._response_user_origin_items) > MAX_TRACKED_TOOL_CALLS:
            self._response_user_origin_items.popitem(last=False)

    def _remember_user_origin_ref(self, item_id: str, origin_ref: MemoryRef) -> None:
        self._user_origin_refs[item_id] = origin_ref
        self._user_origin_refs.move_to_end(item_id)
        while len(self._user_origin_refs) > MAX_TRACKED_TOOL_CALLS:
            self._user_origin_refs.popitem(last=False)

    async def _release_deferred_origin_calls(
        self,
        item_id: str,
        origin_ref: MemoryRef | None,
    ) -> None:
        release_epoch = self.session.session_epoch
        deferred_calls = tuple(self._origin_deferred_tool_calls)
        self._origin_deferred_tool_calls.clear()
        has_keyed_match = any(deferred.user_item_id == item_id for deferred in deferred_calls)
        unkeyed_response_id = (
            None
            if has_keyed_match
            else next(
                (
                    deferred.response_id
                    for deferred in deferred_calls
                    if deferred.user_item_id is None
                ),
                None,
            )
        )
        for deferred in deferred_calls:
            if self.session.session_epoch != release_epoch:
                return
            matches_keyed = deferred.user_item_id == item_id
            matches_unkeyed_batch = (
                deferred.user_item_id is None and deferred.response_id == unkeyed_response_id
            )
            if not matches_keyed and not matches_unkeyed_batch:
                self._origin_deferred_tool_calls.append(deferred)
                continue
            await self._handle_tool_call(
                deferred.event,
                observed_provider_response_id=deferred.response_id,
                origin_ref=origin_ref,
            )

    async def _handle_tool_call(
        self,
        event: ToolCallReady,
        *,
        observed_provider_response_id: str | None = None,
        origin_ref: MemoryRef | None = None,
    ) -> None:
        call_key = (event.session_epoch, event.call_id)
        state = self._tool_call_state(call_key)
        if state is None:
            active_response_id = self.session.active_provider_response_id
            provider_response_id = (
                observed_provider_response_id
                or event.response_id
                or active_response_id
                or event.item_id
            )
            origin_user_input_revision = self.session.provider_turn_user_input_revision(
                provider_response_id
            )
            if origin_user_input_revision is None:
                origin_user_input_revision = self.session.user_input_revision
            origin_phase = self.session.provider_turn_phase(provider_response_id)
            has_provider_origin = event.response_id is not None or active_response_id is not None
            if observed_provider_response_id is not None:
                superseded = origin_phase in {"cancelled", "failed"} or (
                    self.session.provider_turn_was_fenced(provider_response_id)
                )
            else:
                superseded = (
                    (event.response_id is None and active_response_id is None)
                    or (
                        event.response_id is not None
                        and active_response_id not in {None, event.response_id}
                    )
                    or (
                        has_provider_origin
                        and (
                            origin_phase not in {None, "active"}
                            or self.session.provider_turn_was_fenced(provider_response_id)
                        )
                    )
                )
            if (
                len(self._tool_calls) >= MAX_TRACKED_TOOL_CALLS
                or len(self._overflow_tool_calls) >= MAX_PENDING_TOOL_REFUSALS
            ):
                self._prune_terminal_tool_state()
            call_over_capacity = len(self._tool_calls) >= MAX_TRACKED_TOOL_CALLS
            binding = self._tools.bindings.get(event.name)
            requires_semantic_acknowledgement = (
                not superseded
                and binding is not None
                and binding.kind == "delegate"
                and not binding.sync_result
            )
            semantic_reserved = False
            if not call_over_capacity and requires_semantic_acknowledgement:
                semantic_reserved = self._reserve_semantic_acknowledgement()
            over_capacity = call_over_capacity or (
                requires_semantic_acknowledgement and not semantic_reserved
            )
            if over_capacity and len(self._overflow_tool_calls) >= MAX_PENDING_TOOL_REFUSALS:
                await self._reconnect_provider_session()
                return
            if superseded:
                acceptance = self._superseded_acceptance(event)
            elif over_capacity:
                acceptance = self._over_capacity_acceptance(event)
            else:
                try:
                    acceptance = (
                        await self._bridge.accept_tool_call(event)
                        if origin_ref is None
                        else await self._bridge.accept_tool_call(event, origin_ref=origin_ref)
                    )
                except BaseException:
                    if semantic_reserved:
                        self._semantic_acknowledgement_reservations -= 1
                    raise
            self._record_tool_admission(
                logical_name=None if binding is None else binding.logical_name,
                acceptance=acceptance,
                superseded=superseded,
            )
            state = _ToolCallState(
                acceptance=acceptance,
                logical_name=None if binding is None else binding.logical_name,
                provider_response_id=provider_response_id,
                observation="superseded" if superseded else "observed",
                dispatch=(
                    "not_dispatched"
                    if superseded
                    else "rejected"
                    if over_capacity
                    else "fulfilled"
                    if acceptance.inline_fulfilled
                    else "dispatched"
                    if acceptance.accepted
                    else "rejected"
                ),
                provider_session_epoch=event.session_epoch,
                origin_user_input_revision=origin_user_input_revision,
            )
            if (
                acceptance.inline_fulfilled
                and acceptance.telemetry is not None
                and self._telemetry is not None
            ):
                self._telemetry.record("memory.recall", dict(acceptance.telemetry))
            if (
                acceptance.sync_result
                and acceptance.accepted
                and acceptance.delegate_id is not None
            ):
                state.sync = "pending"
                self._pending_sync[acceptance.delegate_id] = call_key
            if semantic_reserved:
                try:
                    if acceptance.accepted and acceptance.delegate_id is not None:
                        if self._semantic_acknowledgement(state) is None:
                            raise RuntimeError("reserved semantic acknowledgement is unavailable")
                finally:
                    self._semantic_acknowledgement_reservations -= 1
            if over_capacity:
                self._overflow_tool_calls[call_key] = state
            else:
                self._tool_calls[call_key] = state
            batch_key = (event.session_epoch, provider_response_id)
            batch = self._continuation_batches.get(batch_key)
            if (
                superseded
                and batch is not None
                and batch.phase
                in {
                    "requested",
                    "bound",
                    "terminal",
                    "abandoned",
                }
            ):
                state.continuation = "abandoned"
                await self._confirm_superseded_output(state)
                return
            if batch is None:
                batch = _ContinuationBatch(
                    provider_response_id=provider_response_id,
                    call_keys=[],
                )
                self._continuation_batches[batch_key] = batch
                self._continuation_fifo.append(batch_key)
            batch.call_keys.append(call_key)
            origin_status = self._origin_status(provider_response_id)
            if superseded:
                batch.origin_status = "cancelled"
                if origin_phase != "cancel_requested":
                    batch.phase = "ready"
            elif origin_status != "active":
                batch.origin_status = origin_status
                batch.phase = "ready"
            if (
                acceptance.accepted
                and acceptance.delegate_id is not None
                and acceptance.executor is not None
                and not acceptance.sync_result
            ):
                summary = acceptance.response_intent.task_summary
                if type(summary) is not str or not summary.strip():
                    display_name = self._executor_display_name(acceptance.executor)
                    summary = f"{display_name} background task"
                self.session.register_delegate(
                    acceptance.delegate_id,
                    summary=summary.strip()[:240],
                    state="running",
                    channel=acceptance.executor,
                )
                if acceptance.executor == "codex" and self._telemetry is not None:
                    self._telemetry.record(
                        "codex.dispatch", {"delegate_id": acceptance.delegate_id}
                    )
                self._publish_codex_state()
        else:
            ledger = self._tool_calls if call_key in self._tool_calls else self._overflow_tool_calls
            ledger.move_to_end(call_key)
            if (
                state.observation == "superseded"
                and state.continuation == "abandoned"
                and state.output == "pending"
            ):
                await self._confirm_superseded_output(state)

    def _tool_call_state(self, call_key: tuple[int, str]) -> _ToolCallState | None:
        return self._tool_calls.get(call_key) or self._overflow_tool_calls.get(call_key)

    def _record_tool_admission(
        self,
        *,
        logical_name: str | None,
        acceptance: ToolAcceptance,
        superseded: bool,
    ) -> None:
        if self._telemetry is None or logical_name is None:
            return
        if superseded:
            outcome = "superseded"
        elif not acceptance.accepted:
            outcome = "rejected"
        elif acceptance.inline_fulfilled:
            outcome = "inline"
        elif acceptance.sync_result:
            outcome = "sync"
        else:
            outcome = "delegated"
        self._telemetry.record(
            "tool.admission",
            {"logical_name": logical_name, "outcome": outcome},
        )

    def _superseded_acceptance(self, event: ToolCallReady) -> ToolAcceptance:
        host_item = HostContextItem.tool_output(
            host_item_id=self._id_factory(),
            event_id=self._id_factory(),
            call_id=event.call_id,
            content='{"state":"superseded"}',
        )
        return ToolAcceptance(
            accepted=False,
            code="superseded",
            host_item=host_item,
            response_intent=HostResponseIntent.tool_result(host_item),
        )

    def _over_capacity_acceptance(self, event: ToolCallReady) -> ToolAcceptance:
        host_item = HostContextItem.tool_output(
            host_item_id=self._id_factory(),
            event_id=self._id_factory(),
            call_id=event.call_id,
            content='{"code":"over_capacity","state":"refused"}',
        )
        return ToolAcceptance(
            accepted=False,
            code="over_capacity",
            host_item=host_item,
            response_intent=HostResponseIntent.tool_result(host_item),
        )

    async def _confirm_superseded_output(self, state: _ToolCallState) -> None:
        if state.output == "confirmed":
            return
        await self.session.inject_tool_output(state.acceptance.host_item)
        state.output = "confirmed"
        state.final_disposition = "superseded"

    async def _resume_confirmed_tool_responses(self) -> None:
        await self._drive_continuations()

    async def _reconnect_provider_session(self, *, expected_epoch: int | None = None) -> bool:
        requested_epoch = self.session.session_epoch if expected_epoch is None else expected_epoch
        async with self._reconnect_lock:
            if self.session.session_epoch != requested_epoch:
                return False
            old_epoch = self.session.session_epoch
            self._invalidate_project_confirmation("provider_replaced")
            self._clear_guard_preemption()
            # Arm the source epoch before awaiting so a Guard already waiting on
            # Session's response-request lock can recognize that the provider
            # identity advanced even if it runs before this coroutine resumes.
            self._provider_reconnect_source_epoch = old_epoch
            await self.session.reconnect(tools=deepcopy(self._provider_schemas))
            if self._provider_reconnect_source_epoch == old_epoch:
                self._provider_epoch_needing_activation = self.session.session_epoch
                self._provider_reconnect_source_epoch = None
            retry_owner = self._urgent_host_response_owner
            self._awaiting_user_origin = False
            self._user_origin_preexisting_response_id = None
            self._unbound_user_origin_items.clear()
            self._response_user_origin_items.clear()
            self._user_origin_refs.clear()
            self._origin_deferred_tool_calls.clear()
            self._release_urgent_host_response_for_epoch(old_epoch)
            if (
                retry_owner is not None
                and retry_owner.session_epoch == old_epoch
                and retry_owner.response_id is None
            ):
                self._requeue_host_item(retry_owner.queued)
            self._clear_captions()
            self._audio_started.clear()
            self._reconcile_tool_state_after_reconnect(old_epoch)
            self._reopen_failed_semantic_acknowledgements()
            self._reconcile_semantic_acknowledgements_after_reconnect()
            await self._resume_confirmed_tool_responses()
            # Let confirmation uncertainty escape to the caller. Calling the
            # public wrapper while holding _reconnect_lock would recursively
            # attempt another reconnect and deadlock.
            await self._delivery_pass()
            return True

    async def _handle_guard_cancel_rejected(self, event: ResponseCancelRejected) -> None:
        if not self._controlled_guard_reconnect:
            return
        async with self._reconnect_lock:
            async with self._delivery_lock:
                preemption = self._guard_preemption
                if (
                    preemption is None
                    or preemption.session_epoch != event.session_epoch
                    or preemption.session_epoch != self.session.session_epoch
                    or preemption.old_response_id != event.response_id
                    or preemption.reconnect_permit_consumed
                    or preemption.reconnect_disallowed
                    or self.session.provider_turn_phase(event.response_id) != "cancel_requested"
                    or self.session.response_event_ids(event.response_id)
                ):
                    return
                queued = next(
                    (
                        candidate
                        for candidate in self._host_items
                        if candidate.intent.item.event_id == preemption.event_id
                    ),
                    None,
                )
                old_generation = preemption.old_generation
                if queued is None or old_generation is None:
                    return
                preemption = replace(
                    preemption,
                    cancel_sent=True,
                    reconnect_permit_consumed=True,
                )
                self._guard_preemption = preemption
                if preemption.deadline_fired:
                    # The alert already fenced the retained renderer generation.
                    # Anchor its uncertainty bound now, before a slow reconnect;
                    # ordinary Guard alerts never consume this permit.
                    self._start_guard_clear_deadline(old_generation)
                old_epoch = self.session.session_epoch
                history = self._guard_recovery_history()
                try:
                    history_outcome = await self.session.reconnect_for_guard(
                        tools=deepcopy(self._provider_schemas),
                        old_generation=old_generation,
                        confirmation_timeout=0.5,
                        history=history,
                        history_mode=self._guard_history_recovery,
                    )
                    self._provider_epoch_needing_activation = self.session.session_epoch
                    if self._telemetry is not None and self._guard_history_recovery != "none":
                        self._telemetry.record(
                            "guard.history_recovery",
                            {
                                "arm": self._guard_history_recovery,
                                "outcome": history_outcome,
                                "item_count": len(history),
                                "pair_count": len(history) // 2,
                                "character_count": sum(len(turn.text) for turn in history),
                            },
                        )
                    self._awaiting_user_origin = False
                    self._user_origin_preexisting_response_id = None
                    self._unbound_user_origin_items.clear()
                    self._response_user_origin_items.clear()
                    self._user_origin_refs.clear()
                    self._origin_deferred_tool_calls.clear()
                    self._release_urgent_host_response_for_epoch(old_epoch)
                    self._clear_captions()
                    self._audio_started.clear()
                    self._reconcile_tool_state_after_reconnect(old_epoch)
                    self._reopen_failed_semantic_acknowledgements()
                    self._reconcile_semantic_acknowledgements_after_reconnect()
                    current = self._guard_preemption
                    if current is None or current.token != preemption.token:
                        return
                    if current.reconnect_aborted:
                        self._clear_guard_preemption(current.token)
                        return
                    self._guard_preemption = replace(
                        current,
                        session_epoch=self.session.session_epoch,
                        old_response_id=None,
                    )
                    await self._deliver_captured_guard_locked(queued)
                except asyncio.CancelledError as failure:
                    print(
                        "[realtime-diagnostic] guard_reconnect_failure "
                        f"type={type(failure).__name__}",
                        flush=True,
                    )
                    self._provider_failed = True
                    self._stop.set()
                    self._delivery_ready.set()
                    raise
                except Exception as failure:
                    if self._telemetry is not None:
                        reason_category = type(failure).__name__
                        self._telemetry.record(
                            "guard.history_recovery_failure",
                            {
                                "arm": self._guard_history_recovery,
                                "reason": reason_category,
                            },
                        )
                    print(
                        "[realtime-diagnostic] guard_reconnect_failure "
                        f"type={type(failure).__name__}",
                        flush=True,
                    )
                    self._provider_failed = True
                    self._stop.set()
                    self._delivery_ready.set()
                    return

    def _guard_recovery_history(self) -> tuple[RecoveryTurn, ...]:
        if self._guard_history_recovery == "none":
            return ()
        memory = getattr(self._runtime, "memory", None)
        if memory is None:
            return ()
        channel = memory.channels.get("conversation")
        if channel is None:
            return ()
        history = project_recovery_turns(
            channel.items,
            max_pairs=self._guard_history_pairs,
        )
        if self._guard_history_recovery == "packed":
            history, _content = pack_recovery_turns(history)
        return history

    def _reconcile_tool_state_after_reconnect(self, old_epoch: int) -> None:
        for call_key in self._pending_sync.values():
            if call_key[0] != old_epoch:
                continue
            state = self._tool_call_state(call_key)
            if state is not None and state.sync == "pending":
                # R105: the dead epoch cannot receive a continuation; the result,
                # when it arrives, becomes a host fact in the new epoch.
                state.sync = "announce"
        for batch_key, batch in self._continuation_batches.items():
            if batch_key[0] != old_epoch:
                continue
            for call_key in batch.call_keys:
                state = self._tool_call_state(call_key)
                if state is None:
                    continue
                needs_semantic_acknowledgement = (
                    state.dispatch == "dispatched" and state.acceptance.accepted
                )
                if state.continuation != "terminal":
                    state.continuation = "abandoned"
                    state.continuation_response_id = None
                    if state.sync == "resolved":
                        # CP3: resolved but its continuation never became terminal —
                        # re-deliver as one announce host fact in the new epoch,
                        # matching the semantic-acknowledgement at-least-once posture.
                        self._announce_resolved_sync_state(state)
                if state.final_disposition is None:
                    if state.dispatch == "not_dispatched":
                        state.final_disposition = "superseded"
                    elif not state.acceptance.accepted:
                        state.final_disposition = "refused"
                    else:
                        state.final_disposition = "abandoned"
                if needs_semantic_acknowledgement:
                    self._queue_background_acknowledgement(state)
            if batch.phase != "terminal":
                batch.phase = "abandoned"
                batch.continuation_response_id = None
        self._continuation_fifo = deque(
            batch_key for batch_key in self._continuation_fifo if batch_key[0] != old_epoch
        )

    def _reconcile_semantic_acknowledgements_after_reconnect(self) -> None:
        for acknowledgement in self._semantic_acknowledgements.values():
            if acknowledgement.phase == "requested" or (
                acknowledgement.phase == "bound" and acknowledgement.binding == "continuation"
            ):
                acknowledgement.phase = "pending"
                acknowledgement.response_id = None
                acknowledgement.binding = None
            if acknowledgement.phase in {"pending", "queued"}:
                self._queue_semantic_acknowledgement(acknowledgement)

    def _reopen_failed_semantic_acknowledgements(self) -> None:
        for acknowledgement in self._semantic_acknowledgements.values():
            if not acknowledgement.failed_retry_consumed:
                continue
            if acknowledgement.phase == "pending":
                self._queue_semantic_acknowledgement(acknowledgement)

    def _prune_terminal_tool_state(self) -> None:
        for ledger in (self._tool_calls, self._overflow_tool_calls):
            for call_key, state in tuple(ledger.items()):
                if state.final_disposition is not None:
                    del ledger[call_key]
        for batch_key, batch in tuple(self._continuation_batches.items()):
            if batch.phase in {"terminal", "abandoned"}:
                del self._continuation_batches[batch_key]
        self._continuation_fifo = deque(
            batch_key
            for batch_key in self._continuation_fifo
            if batch_key in self._continuation_batches
        )

    def _bind_continuation(self, response_id: str) -> None:
        if not self._continuation_fifo:
            return
        batch = self._continuation_batches[self._continuation_fifo[0]]
        if batch.phase != "requested":
            return
        batch.phase = "bound"
        batch.continuation_response_id = response_id
        for call_key in batch.call_keys:
            state = self._tool_call_state(call_key)
            if state is None:
                continue
            state.continuation = "bound"
            state.continuation_response_id = response_id
            acknowledgement = self._semantic_acknowledgement(state)
            if acknowledgement is not None and acknowledgement.phase == "pending":
                acknowledgement.phase = "bound"
                acknowledgement.response_id = response_id
                acknowledgement.binding = "continuation"

    def _finish_continuation(self, event: ResponseTerminal) -> None:
        if not self._continuation_fifo:
            return
        batch_key = self._continuation_fifo[0]
        batch = self._continuation_batches[batch_key]
        if batch.phase != "bound" or batch.continuation_response_id != event.response_id:
            return
        batch.phase = "terminal"
        for call_key in batch.call_keys:
            state = self._tool_call_state(call_key)
            if state is None:
                continue
            state.continuation = "terminal"
            if state.acceptance.accepted:
                state.final_disposition = (
                    "completed" if event.status == "completed" else "abandoned"
                )
            else:
                state.final_disposition = "refused"
        self._continuation_fifo.popleft()

    def _finish_origin(self, response_id: str) -> None:
        batch_key = (self.session.session_epoch, response_id)
        batch = self._continuation_batches.get(batch_key)
        if batch is None or batch.phase != "collecting":
            return
        batch.origin_status = self._origin_status(response_id)
        batch.phase = "ready"

    def _origin_status(
        self,
        response_id: str,
    ) -> Literal["active", "completed", "cancelled", "failed"]:
        phase = self.session.provider_turn_phase(response_id)
        if phase in {"active", "cancel_requested"}:
            return "active"
        if phase == "failed":
            return "failed"
        if phase == "cancelled" or self.session.provider_turn_was_fenced(response_id):
            return "cancelled"
        return "completed"

    async def _drive_continuations(self) -> None:
        # CP3: both handle_event and _delivery_loop drive; the requested/bound
        # check alone cannot stop a second entrant during the provider awaits
        # below, so the whole pass is serialized.
        async with self._continuation_drive_lock:
            await self._drive_continuations_locked()

    def _continuation_request_is_blocked(self) -> bool:
        return self.session.floor.state == "user_speaking" or (
            self._pending_preempt_priority is not None
            and self._pending_preempt_priority >= PREEMPT_MIN_PRIORITY
        )

    async def _drive_continuations_locked(self) -> None:
        if (
            self._pending_preempt_priority is not None
            and self._pending_preempt_priority >= PREEMPT_MIN_PRIORITY
        ):
            return
        if any(
            batch.phase in {"requested", "bound"} for batch in self._continuation_batches.values()
        ):
            return
        while self._continuation_fifo:
            batch = self._continuation_batches[self._continuation_fifo[0]]
            if batch.phase in {"terminal", "abandoned"}:
                self._continuation_fifo.popleft()
                continue
            if batch.phase != "ready":
                return
            if batch.origin_status not in {"cancelled", "failed"} and any(
                state is not None and state.sync == "pending"
                for state in map(self._tool_call_state, batch.call_keys)
            ):
                # R105: a sync member is still awaiting its Handoff or Deadline;
                # the batch stays unready without popping or requesting.
                return
            intents: list[HostResponseIntent] = []
            for call_key in batch.call_keys:
                state = self._tool_call_state(call_key)
                if state is None:
                    continue
                if state.output == "pending":
                    await self.session.inject_tool_output(state.acceptance.host_item)
                    state.output = "confirmed"
                intents.append(state.acceptance.response_intent)
            if batch.origin_status in {"cancelled", "failed"}:
                for call_key in batch.call_keys:
                    state = self._tool_call_state(call_key)
                    if state is None:
                        continue
                    state.continuation = "abandoned"
                    if state.sync == "pending":
                        # R105: an abandoned batch converts the pending sync wait to
                        # the announce path; the result becomes a host fact.
                        state.sync = "announce"
                    elif state.sync == "resolved":
                        # CP3: resolved while collecting — the output injection above
                        # landed in a dead turn and no continuation will speak it, so
                        # downgrade to one announce host fact.
                        self._announce_resolved_sync_state(state)
                    if state.dispatch == "not_dispatched":
                        state.final_disposition = "superseded"
                    elif not state.acceptance.accepted:
                        state.final_disposition = "refused"
                    else:
                        state.final_disposition = "abandoned"
                        self._queue_background_acknowledgement(state)
                batch.phase = "abandoned"
                self._continuation_fifo.popleft()
                continue
            if not intents:
                batch.phase = "abandoned"
                self._continuation_fifo.popleft()
                continue
            if self._continuation_request_is_blocked():
                return
            request_result = await self.session.request_tool_continuation(
                tuple(intents),
                origin_spoken=self._batch_origin_was_delivered(batch),
            )
            if request_result == "retryable":
                return
            if request_result == "rejected":
                for call_key in batch.call_keys:
                    state = self._tool_call_state(call_key)
                    if state is None:
                        continue
                    state.continuation = "abandoned"
                    if state.sync == "pending":
                        state.sync = "announce"
                    elif state.sync == "resolved":
                        self._announce_resolved_sync_state(state)
                    if state.dispatch == "not_dispatched":
                        state.final_disposition = "superseded"
                    elif not state.acceptance.accepted:
                        state.final_disposition = "refused"
                    else:
                        state.final_disposition = "abandoned"
                        self._queue_background_acknowledgement(state)
                batch.phase = "abandoned"
                self._continuation_fifo.popleft()
                continue
            batch.phase = "requested"
            for call_key in batch.call_keys:
                state = self._tool_call_state(call_key)
                if state is not None:
                    state.continuation = "requested"
            return

    def _batch_origin_was_delivered(self, batch: _ContinuationBatch) -> bool:
        if len(batch.call_keys) != 1:
            return False
        state = self._tool_call_state(batch.call_keys[0])
        if state is None or not self._refresh_origin_delivery(state, batch):
            return False
        acknowledgement = self._semantic_acknowledgement(state)
        return (
            acknowledgement is not None
            and acknowledgement.origin_delivered
            and acknowledgement.origin_user_input_revision == self.session.user_input_revision
        )

    def _queue_background_acknowledgement(self, state: _ToolCallState) -> None:
        acknowledgement = self._semantic_acknowledgement(state)
        if acknowledgement is not None:
            self._refresh_origin_delivery(state)
            if acknowledgement.origin_delivered:
                acknowledgement.phase = "delivered"
                acknowledgement.response_id = None
                acknowledgement.binding = None
                return
            self._queue_semantic_acknowledgement(acknowledgement)

    def _refresh_origin_delivery(
        self,
        state: _ToolCallState,
        batch: _ContinuationBatch | None = None,
    ) -> bool:
        key = (state.provider_session_epoch, state.provider_response_id)
        if batch is None:
            batch = self._continuation_batches.get(key)
        single_async = (
            batch is not None
            and len(batch.call_keys) == 1
            and self._tool_call_state(batch.call_keys[0]) is state
            and state.acceptance.response_intent.kind == "delegation_acknowledgement"
        )
        if not single_async or key not in self._origin_delivery_proofs:
            return False
        acknowledgement = self._semantic_acknowledgement(state)
        if acknowledgement is None:
            return False
        acknowledgement.origin_delivered = True
        return True

    def _semantic_acknowledgement(
        self,
        state: _ToolCallState,
    ) -> _SemanticAcknowledgement | None:
        summary = state.acceptance.response_intent.task_summary
        delegate_id = state.acceptance.delegate_id
        if delegate_id is None or summary is None:
            return None
        event_id = f"background:{delegate_id}"
        acknowledgement = self._semantic_acknowledgements.get(event_id)
        if acknowledgement is not None:
            self._semantic_acknowledgements.move_to_end(event_id)
            return acknowledgement
        while len(self._semantic_acknowledgements) >= MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS:
            delivered_id = next(
                (
                    current_id
                    for current_id, current in self._semantic_acknowledgements.items()
                    if current.phase == "delivered"
                ),
                None,
            )
            if delivered_id is None:
                return None
            del self._semantic_acknowledgements[delivered_id]
        channel = state.acceptance.executor
        if channel is None:
            return None
        acknowledgement = _SemanticAcknowledgement(
            event_id=event_id,
            summary=summary[:240],
            channel=channel,
            origin_session_epoch=state.provider_session_epoch,
            origin_response_id=state.provider_response_id,
            origin_user_input_revision=state.origin_user_input_revision,
        )
        self._semantic_acknowledgements[event_id] = acknowledgement
        return acknowledgement

    def _reserve_semantic_acknowledgement(self) -> bool:
        while (
            len(self._semantic_acknowledgements) + self._semantic_acknowledgement_reservations
            >= MAX_TRACKED_SEMANTIC_ACKNOWLEDGEMENTS
        ):
            delivered_id = next(
                (
                    event_id
                    for event_id, acknowledgement in self._semantic_acknowledgements.items()
                    if acknowledgement.phase == "delivered"
                ),
                None,
            )
            if delivered_id is None:
                return False
            del self._semantic_acknowledgements[delivered_id]
        self._semantic_acknowledgement_reservations += 1
        return True

    def _queue_semantic_acknowledgement(
        self,
        acknowledgement: _SemanticAcknowledgement,
    ) -> None:
        if acknowledgement.phase in {"requested", "bound", "delivered"}:
            return
        if any(queued.semantic_event_id == acknowledgement.event_id for queued in self._host_items):
            acknowledgement.phase = "queued"
            return
        host_item_id = self._id_factory()
        manifest = self._executor_manifest(acknowledgement.channel)
        self._queue_host_item(
            HostResponseIntent.host_fact(
                HostContextItem.progress(
                    host_item_id=host_item_id,
                    event_id=acknowledgement.event_id,
                    content=(
                        f"{self._executor_display_name(acknowledgement.channel, manifest=manifest)} "
                        f"已接手开始处理：{acknowledgement.summary}"
                    ),
                )
            ),
            semantic_event_id=acknowledgement.event_id,
            priority=50 if manifest is None else manifest.policy.priority,
        )
        acknowledgement.phase = "queued"

    def _bind_requested_semantic_acknowledgement(self, response_id: str) -> None:
        acknowledgement = next(
            (
                current
                for current in self._semantic_acknowledgements.values()
                if current.phase == "requested"
            ),
            None,
        )
        if acknowledgement is None:
            return
        acknowledgement.phase = "bound"
        acknowledgement.response_id = response_id
        acknowledgement.binding = "fallback"

    def _finish_semantic_acknowledgement(self, event: ResponseTerminal) -> None:
        acknowledgements = tuple(
            current
            for current in self._semantic_acknowledgements.values()
            if current.phase == "bound" and current.response_id == event.response_id
        )
        for acknowledgement in acknowledgements:
            if acknowledgement.origin_delivered:
                acknowledgement.phase = "delivered"
                acknowledgement.response_id = None
                acknowledgement.binding = None
                continue
            if event.status == "completed":
                acknowledgement.phase = "delivered"
                acknowledgement.response_id = None
                acknowledgement.binding = None
            elif acknowledgement.binding == "fallback":
                acknowledgement.phase = "pending"
                acknowledgement.response_id = None
                acknowledgement.binding = None
                if event.status == "failed":
                    if acknowledgement.failed_retry_consumed:
                        continue
                    acknowledgement.failed_retry_consumed = True
                self._queue_semantic_acknowledgement(acknowledgement)
            elif acknowledgement.binding == "continuation":
                acknowledgement.phase = "pending"
                acknowledgement.response_id = None
                acknowledgement.binding = None

    def project_runtime_event(self, event: Event) -> None:
        if (
            isinstance(event, ProgressEvent | ObservationEvent | HandoffEvent)
            and type(event.channel) is not str
        ):
            return
        # R105: sync resolution is a delegate-keyed lookup ahead of the codex-only
        # projections; codex delegates never enter the sync maps.
        if isinstance(event, HandoffEvent) and self._resolve_sync_result(event):
            return
        if isinstance(event, Deadline):
            if self._expire_sync_result(event):
                return
            delegate = self._runtime.delegates.find(event.delegate_id)
            if delegate is None or not self._runtime.delegates.terminated_by_deadline(event):
                return
            adapter = self._runtime.executors.get(delegate.executor)
            op = None if adapter is None else adapter.manifest.op(delegate.op)
            if op is None or op.sync_result:
                return
            display_name = self._executor_display_name(delegate.executor)
            self.session.register_delegate(
                event.delegate_id,
                summary=self._delegate_summary(event.delegate_id, display_name=display_name),
                state="unknown",
                channel=delegate.executor,
                progress_summary=None,
                internal_activity=0,
                elapsed=0.0,
            )
            self._last_progress_summary.pop(event.delegate_id, None)
            self._publish_codex_state()
            self._queue_host_item(
                HostResponseIntent.host_fact(
                    HostContextItem.final(
                        host_item_id=self._id_factory(),
                        event_id=f"deadline:{event.delegate_id}",
                        content=(f"{display_name} 的委派任务超时，未能确认结果。"),
                    )
                ),
                priority=adapter.manifest.policy.priority,
            )
            return
        manifest: ExecutorManifest | None = None
        claimed_delegate = None
        if isinstance(event, ProgressEvent | ObservationEvent | HandoffEvent):
            manifest = self._executor_manifest(event.channel)
            if manifest is None:
                return
        if isinstance(event, HandoffEvent):
            claimed_delegate = self._runtime.delegates.claimed_handoff(event)
            if claimed_delegate is None or claimed_delegate.executor != event.channel:
                return
        if self._telemetry is not None and getattr(event, "channel", None) == "codex":
            if isinstance(event, ProgressEvent):
                self._telemetry.record(
                    "codex.progress",
                    {
                        "delegate_id": event.delegate_id,
                        "phase": event.phase,
                        "internal_activity": event.internal_activity,
                    },
                )
            elif isinstance(event, HandoffEvent):
                self._telemetry.record(
                    "codex.handoff",
                    {"delegate_id": event.delegate_id, "outcome": event.outcome},
                )
        if isinstance(event, ObservationEvent):
            delegate = observation_delegate(event, self._runtime.delegates)
            if delegate is None:
                return
            display_name = self._executor_display_name(event.channel, manifest=manifest)
            self.session.register_delegate(
                event.delegate_id,
                summary=self._delegate_summary(event.delegate_id, display_name=display_name),
                state="running",
                channel=event.channel,
            )
            self._publish_codex_state()
            hit = event.content.get("hit") is True
            if not hit:
                return
            if manifest.policy.suggest and delegate.routing_class == "ambient":
                return
            content = _generic_final_speech_view(display_name, "ok", event.content)[
                :MAX_HOST_FACT_CHARS
            ]
            self._queue_host_item(
                HostResponseIntent.host_fact(
                    HostContextItem.final(
                        host_item_id=self._id_factory(),
                        event_id=f"observation:{event.delegate_id}:{event.seq}",
                        content=content,
                    )
                ),
                priority=max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY),
                preemptive=manifest.policy.priority >= PREEMPT_MIN_PRIORITY,
                guard_delegate_id=(event.delegate_id if event.channel == "guard" else None),
            )
        elif isinstance(event, ProgressEvent):
            # CP1: observers receive events unconditionally, including ones the
            # runtime validator dropped from Memory. Re-check the R103 shape and
            # exact active delegate identity here before projecting anything.
            if (
                type(event.channel) is not str
                or type(event.delegate_id) is not str
                or type(event.op) is not str
                or not event.op
                or event.phase not in {"started", "working"}
                or type(event.internal_activity) is not int
                or type(event.elapsed) not in {int, float}
                or not math.isfinite(event.elapsed)
                or event.elapsed < 0
                or (event.phase == "started" and event.internal_activity != 0)
                or (event.phase == "working" and not 1 <= event.internal_activity <= 1_048_576)
            ):
                return
            delegate = self._runtime.delegates.in_flight_delegate(event.delegate_id)
            if delegate is None or delegate.executor != event.channel or delegate.op != event.op:
                return
            display_name = self._executor_display_name(event.channel, manifest=manifest)
            summary = event.summary
            if not valid_progress_summary(summary, phase=event.phase):
                summary = None
            if summary is not None:
                # CP2: prepare once at the storage boundary so the recovery
                # frame (session-rendered) never carries raw markdown either.
                summary = prepare_for_speech(summary, limit=SPEECH_FINAL_LIMIT)[0] or None
            self.session.register_delegate(
                event.delegate_id,
                summary=self._delegate_summary(event.delegate_id, display_name=display_name),
                state="running",
                channel=event.channel,
                progress_summary=summary,
                internal_activity=event.internal_activity,
                elapsed=float(event.elapsed),
            )
            self._publish_codex_state()
            if manifest.policy.progress_via_surrogate and event.phase == "working":
                return
            has_realtime_acknowledgement = (
                f"background:{event.delegate_id}" in self._semantic_acknowledgements
            )
            if event.phase == "started" and has_realtime_acknowledgement:
                # #49: the delegation acknowledgement continuation already told
                # the user the task was accepted; a spoken started fact would
                # repeat it. Delegate state registration above still happens.
                return
            if event.phase == "started":
                content = f"{display_name} 已开始处理这个任务。"
            elif summary is not None:
                # Same-summary skip (R103): state registration already happened;
                # only the host injection is suppressed. None-summary events keep
                # the field template and are never deduped by this mechanism.
                if self._last_progress_summary.get(event.delegate_id) == summary:
                    return
                self._last_progress_summary[event.delegate_id] = summary
                content = (
                    f"{display_name} 正在执行：{summary}（已进行{float(event.elapsed):.0f}秒）"
                )
            else:
                content = f"{display_name} 仍在处理这个任务，目前已推进 {event.internal_activity} 个步骤。"
            host_item_id = self._id_factory()
            self._queue_host_item(
                HostResponseIntent.host_fact(
                    HostContextItem.progress(
                        host_item_id=host_item_id,
                        event_id=(
                            f"progress:{event.delegate_id}:{event.phase}:{event.internal_activity}"
                        ),
                        content=content,
                    )
                ),
                priority=manifest.policy.priority,
            )
        elif isinstance(event, HandoffEvent):
            display_name = self._executor_display_name(event.channel, manifest=manifest)
            assert claimed_delegate is not None
            direct_suggestion_handoff = (
                manifest.policy.suggest
                and event.outcome == "ok"
                and claimed_delegate.routing_class == "user_awaited"
            )
            suppress_unselected_suggestion = (
                manifest.policy.suggest and event.outcome == "ok" and not direct_suggestion_handoff
            )
            state = "completed" if event.outcome == "ok" else "failed"
            self.session.register_delegate(
                event.delegate_id,
                summary=self._delegate_summary(event.delegate_id, display_name=display_name),
                state=state,
                channel=event.channel,
            )
            # CP1: a settled delegate leaves no dedup residue behind.
            self._last_progress_summary.pop(event.delegate_id, None)
            self._publish_codex_state()
            if suppress_unselected_suggestion:
                return
            successful_monitor_stop = (
                event.channel in {"watch", "guard"}
                and event.outcome == "ok"
                and type(event.content) is dict
                and (
                    (claimed_delegate.op == "stop" and event.content.get("stopped") is True)
                    or (claimed_delegate.op == "start" and event.content.get("state") == "stopped")
                )
            )
            if successful_monitor_stop:
                # The user-awaited stop tool's continuation is the single spoken
                # confirmation. Both terminal handoffs remain authoritative in
                # Runtime/Memory/Board, but projecting either one would duplicate
                # that acknowledgement (and projecting both produced three lines).
                return
            host_item_id = self._id_factory()
            final_view = (
                _final_speech_view(event.outcome, event.content)
                if event.channel == "codex"
                else _generic_final_speech_view(display_name, event.outcome, event.content)
            )
            content = final_view[:MAX_HOST_FACT_CHARS]
            hit = (
                event.outcome == "ok"
                and type(event.content) is dict
                and event.content.get("hit") is True
            )
            self._queue_host_item(
                HostResponseIntent.host_fact(
                    HostContextItem.final(
                        host_item_id=host_item_id,
                        event_id=f"final:{event.delegate_id}",
                        content=content,
                    )
                ),
                priority=(
                    max(manifest.policy.priority, HIT_ALERT_MIN_PRIORITY)
                    if hit
                    else manifest.policy.priority
                ),
                preemptive=manifest.policy.priority >= PREEMPT_MIN_PRIORITY and hit,
                guard_delegate_id=(event.delegate_id if event.channel == "guard" and hit else None),
            )

    def _resolve_sync_result(self, event: HandoffEvent) -> bool:
        """First event wins (R105): pop the wait entry so later events are no-ops."""
        call_key = self._pending_sync.pop(event.delegate_id, None)
        if call_key is None:
            if self._late_sync.pop(event.delegate_id, None) is None:
                return False
            self._queue_sync_announcement(event)
            return True
        state = self._tool_call_state(call_key)
        if state is None:
            # CP3: pruning removed the abandoned call state but the delegate's
            # result is still outstanding — announce instead of swallowing it.
            self._queue_sync_announcement(event)
            return True
        if state.sync == "pending":
            self._confirm_sync_output(state, self._sync_result_content(event))
            state.sync = "resolved"
            self._delivery_ready.set()
        elif state.sync == "announce":
            self._queue_sync_announcement(event)
        return True

    def _expire_sync_result(self, event: Deadline) -> bool:
        call_key = self._pending_sync.pop(event.delegate_id, None)
        if call_key is None:
            return False
        state = self._tool_call_state(call_key)
        if state is not None:
            if state.sync == "pending":
                self._confirm_sync_output(
                    state,
                    json.dumps(
                        {"state": "timeout"},
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                )
                self._delivery_ready.set()
            elif state.sync != "announce":
                return True
            state.sync = "announce"
        # A timeout is not news worth speaking; remember the delegate (even when
        # pruning removed the call state, CP3) so only a real late handoff
        # downgrades to one host fact.
        self._late_sync[event.delegate_id] = call_key
        while len(self._late_sync) > MAX_LATE_SYNC_RESULTS:
            self._late_sync.popitem(last=False)
        return True

    def _confirm_sync_output(self, state: _ToolCallState, content: str) -> None:
        previous = state.acceptance.host_item
        assert previous.call_id is not None
        host_item = HostContextItem.tool_output(
            host_item_id=previous.host_item_id,
            event_id=previous.event_id,
            call_id=previous.call_id,
            content=content,
        )
        state.acceptance = replace(
            state.acceptance,
            host_item=host_item,
            response_intent=HostResponseIntent.tool_result(host_item),
        )

    def _queue_sync_announcement(self, event: HandoffEvent) -> None:
        self._queue_host_item(
            HostResponseIntent.host_fact(
                HostContextItem.final(
                    host_item_id=self._id_factory(),
                    event_id=f"sync:{event.delegate_id}",
                    content=self._sync_result_content(event),
                )
            ),
            priority=self._executor_priority(event.channel),
        )

    def _announce_resolved_sync_state(self, state: _ToolCallState) -> None:
        """CP3: a resolved-but-undelivered sync result of an abandoned batch keeps
        its compact view — requeue it as the one announce host fact."""
        delegate_id = state.acceptance.delegate_id
        if delegate_id is None:
            return
        state.sync = "announce"
        self._queue_host_item(
            HostResponseIntent.host_fact(
                HostContextItem.final(
                    host_item_id=self._id_factory(),
                    event_id=f"sync:{delegate_id}",
                    content=state.acceptance.host_item.content,
                )
            ),
            priority=self._executor_priority(state.acceptance.executor),
        )

    @staticmethod
    def _sync_result_content(event: HandoffEvent) -> str:
        """Compact model-grounding view of a sync handoff (R105): bounded titles and
        snippets plus host-side source names; no internal refs, provider identifiers,
        or digests."""
        content = event.content if type(event.content) is dict else {}
        view: dict[str, object]
        if event.channel == "search":
            if event.outcome == "ok":
                results: list[dict[str, str]] = []
                raw_results = content.get("results")
                if isinstance(raw_results, list):
                    for raw in raw_results:
                        if type(raw) is not dict:
                            continue
                        title = raw.get("title")
                        snippet = raw.get("snippet")
                        url = raw.get("canonical_url")
                        results.append(
                            {
                                "title": (
                                    title[:_SYNC_RESULT_TITLE_CHARS] if type(title) is str else ""
                                ),
                                "snippet": (
                                    snippet[:_SYNC_RESULT_SNIPPET_CHARS]
                                    if type(snippet) is str
                                    else ""
                                ),
                                "source": (
                                    (urlsplit(url).hostname or "") if type(url) is str else ""
                                ),
                            }
                        )
                query = content.get("query")
                view = {
                    "state": "ok",
                    "query": query[:512] if type(query) is str else None,
                    "results": results,
                }
                # P1: truncating serialized JSON produces unterminated strings at
                # legal-maximum input. Shrink the view instead — halve snippets,
                # then drop trailing results — until it encodes within budget.
                encoded = _encode_view(view)
                while len(encoded) > MAX_HOST_FACT_CHARS and results:
                    longest = max(len(result["snippet"]) for result in results)
                    if longest > 50:
                        for result in results:
                            result["snippet"] = result["snippet"][: max(50, longest // 2)]
                    else:
                        results.pop()
                    encoded = _encode_view(view)
                return encoded[:MAX_HOST_FACT_CHARS]
            view = {"state": event.outcome, "error": content.get("error")}
        else:
            view = {"state": event.outcome, "content": event.content}
        return _encode_view(view)[:MAX_HOST_FACT_CHARS]

    async def flush_host_items(self) -> None:
        try:
            await self._delivery_pass()
        except ItemDeliveryUncertainError as failure:
            await self._recover_uncertain_delivery(failure)

    async def _recover_uncertain_delivery(
        self,
        failure: ItemDeliveryUncertainError,
    ) -> None:
        if failure.item_kind == "recovery":
            self._fail_uncertain_delivery()
            return
        if failure.host_item_id in self._uncertain_delivery_retries:
            self._fail_uncertain_delivery()
            return
        self._uncertain_delivery_retries[failure.host_item_id] = None
        self._uncertain_delivery_retries.move_to_end(failure.host_item_id)
        while len(self._uncertain_delivery_retries) > MAX_UNCERTAIN_DELIVERY_RETRIES:
            self._uncertain_delivery_retries.popitem(last=False)
        try:
            reconnected = await self._reconnect_provider_session(
                expected_epoch=failure.session_epoch
            )
            if not reconnected:
                await self._delivery_pass()
        except ItemDeliveryUncertainError:
            self._fail_uncertain_delivery()

    def _fail_uncertain_delivery(self) -> None:
        print("[realtime-diagnostic] uncertain_delivery_exhausted", flush=True)
        self._provider_failed = True
        self._urgent_host_response_owner = None
        self._clear_guard_preemption()
        self._stop.set()
        self._delivery_ready.set()

    async def _delivery_pass(self) -> None:
        async with self._delivery_lock:
            if self.session.release_stale_user_hold(USER_HOLD_MAX_S):
                print("[realtime-diagnostic] floor_stale_hold_released", flush=True)
            eligible_preempt_was_armed = (
                self._pending_preempt_priority is not None
                and self._pending_preempt_priority >= PREEMPT_MIN_PRIORITY
            )
            await self._maybe_preempt_locked()
            await self._flush_host_items_locked()
            should_redrive_continuations = (
                eligible_preempt_was_armed
                and (
                    self._pending_preempt_priority is None
                    or self._pending_preempt_priority < PREEMPT_MIN_PRIORITY
                )
                and self.session.foreground_idle
                and self.session.floor.state != "user_speaking"
            )
        self._schedule_stale_hold_wake()
        if should_redrive_continuations:
            await self._drive_continuations()

    async def _maybe_preempt_locked(self) -> None:
        priority = self._pending_preempt_priority
        if priority is None or priority < PREEMPT_MIN_PRIORITY:
            return
        if self.session.floor.state == "user_speaking":
            return
        if self.session.foreground_idle:
            return
        if self._urgent_host_response_owner is not None:
            return
        if self._guard_preemption is not None:
            return
        queued = min(
            (
                candidate
                for candidate in self._host_items
                if candidate.preemptive and candidate.priority >= PREEMPT_MIN_PRIORITY
            ),
            default=None,
        )
        if queued is None:
            return
        self._guard_preemption_token += 1
        preemption = _GuardPreemption(
            token=self._guard_preemption_token,
            session_epoch=self.session.session_epoch,
            event_id=queued.intent.item.event_id,
            old_response_id=self.session.active_provider_response_id,
            old_generation=self.session.current_generation,
            queued_at=queued.queued_at,
        )
        self._guard_preemption = preemption
        self._guard_alert_deadline = asyncio.create_task(
            self._fire_guard_alert_deadline(preemption)
        )
        if self._telemetry is not None:
            self._telemetry.record("guard.preempt_started", {})
        try:
            preempted = await self.session.host_preempt()
        except BaseException:
            self._clear_guard_preemption(preemption.token)
            raise
        if not preempted:
            self._clear_guard_preemption(preemption.token)
            return
        response_id = self.session.active_provider_response_id
        current = self._guard_preemption
        if (
            response_id is not None
            and current is not None
            and current.token == preemption.token
            and self.session.provider_turn_phase(response_id) == "cancel_requested"
        ):
            if current.old_response_id is None:
                self._guard_preemption = replace(current, old_response_id=response_id)
            self._record_guard_cancel_sent(response_id)

    async def _flush_host_items_locked(self) -> None:
        while self._host_items:
            queued = self._host_items[0]
            preemptive_overlap = self._guard_overlap_allowed(queued)
            ordinary_delivery = self.session.foreground_idle and self.session.floor.state == "idle"
            if not preemptive_overlap and not ordinary_delivery:
                break
            heapq.heappop(self._host_items)
            user_activation = self._guard_activation_required(queued)
            try:
                if user_activation:
                    delivery = await self.session.deliver_host_response(
                        queued.intent,
                        as_user_activation=True,
                    )
                elif preemptive_overlap:
                    preemption = self._guard_preemption
                    confirmation_timeout = (
                        0.5
                        if preemption is not None
                        and preemption.reconnect_permit_consumed
                        and preemption.event_id == queued.intent.item.event_id
                        else None
                    )
                    if confirmation_timeout is None:
                        delivery = await self.session.deliver_preemptive_host_response(
                            queued.intent
                        )
                    else:
                        delivery = await self.session.deliver_preemptive_host_response(
                            queued.intent,
                            confirmation_timeout=confirmation_timeout,
                        )
                else:
                    delivery = await self.session.deliver_host_response(queued.intent)
            except Exception:
                heapq.heappush(self._host_items, queued)
                raise
            delivered = delivery.accepted
            if delivered and user_activation:
                self._provider_epoch_needing_activation = None
                self._provider_reconnect_source_epoch = None
            if queued.preemptive:
                self._pending_preempt_priority = max(
                    (candidate.priority for candidate in self._host_items if candidate.preemptive),
                    default=None,
                )
            if delivered and queued.semantic_event_id is not None:
                acknowledgement = self._semantic_acknowledgements.get(queued.semantic_event_id)
                if acknowledgement is not None and acknowledgement.phase == "queued":
                    acknowledgement.phase = "requested"
            if (
                delivered
                and queued.preemptive
                and not self._stop.is_set()
                and not self._provider_failed
                and delivery.injection_epoch == self.session.session_epoch
            ):
                assert delivery.injection_epoch is not None
                self._urgent_delivery_token += 1
                self._urgent_host_response_owner = _UrgentHostResponseOwner(
                    delivery_token=self._urgent_delivery_token,
                    session_epoch=delivery.injection_epoch,
                    event_id=queued.intent.item.event_id,
                    queued=queued,
                )
            if delivered:
                if self._telemetry is not None:
                    self._telemetry.record(
                        "hostitem.injected",
                        {"event_id": queued.intent.item.event_id},
                    )
                break

    async def _deliver_captured_guard_locked(self, queued: _QueuedHostResponse) -> None:
        """Deliver the exact Guard captured before reconnect, independent of heap order."""
        try:
            index = self._host_items.index(queued)
        except ValueError:
            return
        self._host_items[index] = self._host_items[-1]
        self._host_items.pop()
        if index < len(self._host_items):
            heapq.heapify(self._host_items)
        user_activation = self._guard_activation_required(queued)
        try:
            delivery = await self.session.deliver_preemptive_host_response(
                queued.intent,
                confirmation_timeout=0.5,
                response_allowed=lambda: self._guard_response_is_allowed(
                    queued.intent.item.event_id
                ),
                as_user_activation=user_activation,
            )
        except Exception:
            heapq.heappush(self._host_items, queued)
            raise
        if not delivery.accepted:
            heapq.heappush(self._host_items, queued)
            self._pending_preempt_priority = max(
                (candidate.priority for candidate in self._host_items if candidate.preemptive),
                default=None,
            )
            return
        if user_activation:
            self._provider_epoch_needing_activation = None
            self._provider_reconnect_source_epoch = None
        self._pending_preempt_priority = max(
            (candidate.priority for candidate in self._host_items if candidate.preemptive),
            default=None,
        )
        if queued.semantic_event_id is not None:
            acknowledgement = self._semantic_acknowledgements.get(queued.semantic_event_id)
            if acknowledgement is not None and acknowledgement.phase == "queued":
                acknowledgement.phase = "requested"
        if (
            not self._stop.is_set()
            and not self._provider_failed
            and delivery.injection_epoch == self.session.session_epoch
        ):
            assert delivery.injection_epoch is not None
            self._urgent_delivery_token += 1
            self._urgent_host_response_owner = _UrgentHostResponseOwner(
                delivery_token=self._urgent_delivery_token,
                session_epoch=delivery.injection_epoch,
                event_id=queued.intent.item.event_id,
                queued=queued,
            )
        if self._telemetry is not None:
            self._telemetry.record(
                "hostitem.injected",
                {"event_id": queued.intent.item.event_id},
            )

    def _guard_response_is_allowed(self, event_id: str) -> bool:
        preemption = self._guard_preemption
        return (
            preemption is not None
            and preemption.event_id == event_id
            and not preemption.reconnect_aborted
            and self.session.floor.state != "user_speaking"
        )

    def _guard_overlap_allowed(self, queued: _QueuedHostResponse) -> bool:
        preemption = self._guard_preemption
        if (
            preemption is None
            or not queued.preemptive
            or queued.intent.item.event_id != preemption.event_id
            or preemption.session_epoch != self.session.session_epoch
            or not self.session.provider_idle
            or self.session.floor.state == "user_speaking"
        ):
            return False
        if self.session.floor.state == "idle":
            return True
        old_generation = preemption.old_generation
        if (
            self.session.floor.state != "agent_speaking"
            or old_generation is None
            or self.session.floor.utterance_id != old_generation.utterance_id
        ):
            return False
        current = self.session.current_generation
        return current is None or current == old_generation

    async def _fire_guard_alert_deadline(self, preemption: _GuardPreemption) -> None:
        try:
            delay = max(
                0.0,
                preemption.queued_at + GUARD_ALERT_DEADLINE_S - self._clock.now(),
            )
            await self._clock.sleep(delay)
            current = self._guard_preemption
            if current is None or current.token != preemption.token or current.deadline_fired:
                return
            if current.reconnect_aborted:
                self._clear_guard_preemption(current.token)
                return
            controlled_handoff = current.reconnect_permit_consumed
            expired = (
                self.session.alert_guard_handoff(current.old_generation)
                if controlled_handoff and current.old_generation is not None
                else self.session.expire_host_preempt(current.old_generation)
            )
            if not expired:
                return
            current = replace(current, deadline_fired=True)
            self._guard_preemption = current
            if (
                self._controlled_guard_reconnect
                and current.reconnect_permit_consumed
                and current.old_generation is not None
            ):
                self._start_guard_clear_deadline(current.old_generation)
            if self._telemetry is not None:
                self._telemetry.record("guard.alert_deadline_fired", {})
            if current.replacement_terminal:
                self._clear_guard_preemption(current.token)
            self._delivery_ready.set()
        except asyncio.CancelledError:
            raise
        except Exception as failure:
            print(
                f"[realtime-diagnostic] guard_alert_failure type={type(failure).__name__}",
                flush=True,
            )
        finally:
            if self._guard_alert_deadline is asyncio.current_task():
                self._guard_alert_deadline = None

    def _clear_guard_preemption(self, token: int | None = None) -> asyncio.Task[None] | None:
        current = self._guard_preemption
        if current is None or (token is not None and current.token != token):
            return None
        self._guard_preemption = None
        task, self._guard_alert_deadline = self._guard_alert_deadline, None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
        return task

    def _bind_urgent_host_response(self, event: ResponseStarted | ResponseAudioDelta) -> None:
        owner = self._urgent_host_response_owner
        if owner is None or owner.session_epoch != event.session_epoch:
            return
        if owner.response_id is None:
            if not isinstance(event, ResponseStarted):
                return
            if owner.event_id not in self.session.response_event_ids(event.response_id):
                return
            owner = replace(owner, response_id=event.response_id)
        elif owner.response_id != event.response_id:
            return
        generation = self.session.current_generation
        if (
            generation is not None
            and generation.session_epoch == event.session_epoch
            and generation.response_id == event.response_id
        ):
            owner = replace(owner, generation=generation)
        if (
            self._urgent_host_response_owner is not None
            and self._urgent_host_response_owner.delivery_token == owner.delivery_token
        ):
            self._urgent_host_response_owner = owner

    def _finish_guard_first_audio(self, event: ResponseStarted | ResponseAudioDelta) -> None:
        preemption = self._guard_preemption
        owner = self._urgent_host_response_owner
        generation = self.session.current_generation
        if (
            preemption is None
            or owner is None
            or generation is None
            or preemption.event_id != owner.event_id
            or preemption.session_epoch != event.session_epoch
            or owner.response_id != event.response_id
            or generation.session_epoch != event.session_epoch
            or generation.response_id != event.response_id
        ):
            return
        token = preemption.token
        self._clear_guard_preemption(token)
        if (
            self._controlled_guard_reconnect
            and preemption.reconnect_permit_consumed
            and preemption.old_generation is not None
        ):
            self._start_guard_clear_deadline(preemption.old_generation)
        if self._telemetry is not None:
            self._telemetry.record(
                "guard.first_audio_switch",
                {
                    "elapsed_ms": max(
                        0,
                        round((self._clock.now() - preemption.queued_at) * 1000),
                    )
                },
            )

    def _start_guard_clear_deadline(self, generation: PlaybackGeneration) -> None:
        key = generation.utterance_id, generation.generation_epoch
        if key in self._guard_clear_deadlines:
            return
        self._guard_clear_deadlines[key] = asyncio.create_task(
            self._retire_guard_clear_unknown(generation)
        )

    async def _retire_guard_clear_unknown(self, generation: PlaybackGeneration) -> None:
        key = generation.utterance_id, generation.generation_epoch
        try:
            await self._clock.sleep(GUARD_CLEAR_ACK_DEADLINE_S)
            if not self.session.retire_playback_clear_unknown(generation):
                return
            if self._telemetry is not None:
                self._telemetry.record(
                    "renderer_clear_unknown",
                    {
                        "session_epoch": generation.session_epoch,
                        "generation_epoch": generation.generation_epoch,
                    },
                )
            self._delivery_ready.set()
        except asyncio.CancelledError:
            raise
        finally:
            if self._guard_clear_deadlines.get(key) is asyncio.current_task():
                del self._guard_clear_deadlines[key]

    def _cancel_guard_clear_deadline(self, utterance_id: str, generation_epoch: int) -> None:
        task = self._guard_clear_deadlines.pop((utterance_id, generation_epoch), None)
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    def _record_guard_cancel_terminal(self, event: ResponseTerminal) -> None:
        preemption = self._guard_preemption
        if (
            preemption is None
            or preemption.session_epoch != event.session_epoch
            or preemption.old_response_id != event.response_id
        ):
            return
        success = event.status == "cancelled" and event.reason == "client_cancelled"
        if event.status == "cancelled":
            reason_category = "client_cancelled" if success else "other_cancelled"
        else:
            reason_category = event.status
        if self._telemetry is not None:
            self._telemetry.record(
                "provider.cancel_terminal",
                {
                    "status": event.status,
                    "reason_category": reason_category,
                    "success": success,
                    "elapsed_ms": max(
                        0,
                        round((self._clock.now() - preemption.queued_at) * 1000),
                    ),
                },
            )

    def _record_guard_cancel_sent(self, response_id: str) -> None:
        preemption = self._guard_preemption
        if (
            preemption is None
            or preemption.session_epoch != self.session.session_epoch
            or preemption.old_response_id != response_id
            or preemption.cancel_sent
        ):
            return
        self._guard_preemption = replace(preemption, cancel_sent=True)
        if self._telemetry is not None:
            self._telemetry.record(
                "provider.cancel_sent",
                {
                    "elapsed_ms": max(
                        0,
                        round((self._clock.now() - preemption.queued_at) * 1000),
                    )
                },
            )

    def _mark_guard_replacement_terminal(
        self,
        owner: _UrgentHostResponseOwner | None,
    ) -> None:
        preemption = self._guard_preemption
        if (
            preemption is None
            or owner is None
            or preemption.event_id != owner.event_id
            or preemption.session_epoch != owner.session_epoch
        ):
            return
        preemption = replace(preemption, replacement_terminal=True)
        self._guard_preemption = preemption
        if preemption.deadline_fired:
            self._clear_guard_preemption(preemption.token)

    def _retire_fenced_prestart_urgent(self) -> None:
        receipt = self.session.take_fence_interruption()
        owner = self._urgent_host_response_owner
        if (
            receipt is None
            or owner is None
            or owner.response_id is not None
            or owner.session_epoch != receipt.session_epoch
            or owner.event_id not in receipt.event_ids
        ):
            return
        self._release_urgent_host_response(owner)

    def _urgent_owner_for_response(
        self,
        session_epoch: int,
        response_id: str,
    ) -> _UrgentHostResponseOwner | None:
        owner = self._urgent_host_response_owner
        if (
            owner is None
            or owner.session_epoch != session_epoch
            or owner.response_id != response_id
        ):
            return None
        return owner

    def _urgent_owner_for_generation(
        self,
        utterance_id: str,
        generation_epoch: int,
    ) -> _UrgentHostResponseOwner | None:
        owner = self._urgent_host_response_owner
        generation = None if owner is None else owner.generation
        if (
            generation is None
            or generation.utterance_id != utterance_id
            or generation.generation_epoch != generation_epoch
        ):
            return None
        return owner

    def _release_urgent_host_response(
        self,
        owner: _UrgentHostResponseOwner | None,
    ) -> None:
        current = self._urgent_host_response_owner
        if (
            owner is not None
            and current is not None
            and current.delivery_token == owner.delivery_token
        ):
            self._urgent_host_response_owner = None

    def _release_urgent_host_response_for_epoch(self, session_epoch: int) -> None:
        owner = self._urgent_host_response_owner
        if owner is not None and owner.session_epoch == session_epoch:
            self._urgent_host_response_owner = None

    def _schedule_stale_hold_wake(self) -> None:
        """The last queued item has no later event to re-trigger delivery, so a
        flush blocked by a user hold arms one clock-deadline wake instead of
        waiting for a provider speech-end that may never arrive."""
        if not self._host_items or self.session.floor.state != "user_speaking":
            return
        if self._stale_hold_wake is not None and not self._stale_hold_wake.done():
            return
        self._stale_hold_wake = asyncio.create_task(self._wake_at_stale_hold_deadline())

    async def _wake_at_stale_hold_deadline(self) -> None:
        reschedule = False
        try:
            held = await self.session.wait_for_stale_hold(USER_HOLD_MAX_S)
            while held and self._host_items and not self._stop.is_set():
                try:
                    await self.flush_host_items()
                except RealtimeDeliveryError as failure:
                    self._report_delivery_failure(failure)
                    await self._clock.sleep(STALE_DELIVERY_RETRY_S)
                    continue
                reschedule = self.session.floor.state == "user_speaking"
                break
        except Exception as failure:
            print(
                f"[realtime-diagnostic] stale_wake_failure type={type(failure).__name__}",
                flush=True,
            )
            self._provider_failed = True
            self._urgent_host_response_owner = None
            self._stop.set()
            self._delivery_ready.set()
        finally:
            self._stale_hold_wake = None
        if reschedule and not self._stop.is_set():
            self._schedule_stale_hold_wake()

    async def _receive_loop(self) -> None:
        while not self._stop.is_set():
            stream_epoch = self.session.session_epoch
            received = False
            async for event in self._provider.events():
                if event.session_epoch != self.session.session_epoch:
                    continue
                received = True
                try:
                    await self.handle_event(event)
                except ItemDeliveryUncertainError as failure:
                    await self._recover_uncertain_delivery(failure)
                except RealtimeDeliveryError as failure:
                    self._report_delivery_failure(failure)
                if self._stop.is_set():
                    return
            if self._stop.is_set() or self._provider_failed:
                return
            if self.session.session_epoch != stream_epoch:
                continue
            if not received:
                return

    async def _delivery_loop(self) -> None:
        while not self._stop.is_set():
            await self._delivery_ready.wait()
            self._delivery_ready.clear()
            if not self._stop.is_set():
                try:
                    await self.flush_host_items()
                    # R105: a sync resolution may have made a held batch ready;
                    # _drive_continuations is reentrancy-safe (early-returns while
                    # a batch is requested or bound).
                    await self._drive_continuations()
                except RealtimeDeliveryError as failure:
                    self._report_delivery_failure(failure)

    def _queue_host_item(
        self,
        intent: HostResponseIntent,
        *,
        semantic_event_id: str | None = None,
        priority: int = 50,
        preemptive: bool = False,
        guard_delegate_id: str | None = None,
    ) -> None:
        effective_priority = min(priority, USER_PRIORITY - 1)
        guard_activation = (
            None
            if guard_delegate_id is None
            else _GuardActivationAuthority(
                delegate_id=guard_delegate_id,
                event_id=intent.item.event_id,
                source_epoch=self.session.session_epoch,
            )
        )
        if self._telemetry is not None:
            self._telemetry.record("hostitem.queued", {"event_id": intent.item.event_id})
        self._host_item_seq += 1
        queued = _QueuedHostResponse(
            sort_key=(-effective_priority, -int(preemptive), self._host_item_seq),
            intent=intent,
            priority=effective_priority,
            preemptive=preemptive,
            seq=self._host_item_seq,
            queued_at=self._clock.now(),
            semantic_event_id=semantic_event_id,
            guard_activation=guard_activation,
        )
        heapq.heappush(self._host_items, queued)
        if preemptive:
            pending_priority = self._pending_preempt_priority
            self._pending_preempt_priority = max(
                effective_priority,
                effective_priority if pending_priority is None else pending_priority,
            )
        self._delivery_ready.set()

    def _requeue_host_item(self, queued: _QueuedHostResponse) -> None:
        if self._telemetry is not None:
            self._telemetry.record("hostitem.queued", {"event_id": queued.intent.item.event_id})
        heapq.heappush(self._host_items, queued)
        if queued.preemptive:
            pending_priority = self._pending_preempt_priority
            self._pending_preempt_priority = max(
                queued.priority,
                queued.priority if pending_priority is None else pending_priority,
            )
        self._delivery_ready.set()

    @staticmethod
    def _guard_activation_authorized(queued: _QueuedHostResponse) -> bool:
        authority = queued.guard_activation
        if authority is None or authority.event_id != queued.intent.item.event_id:
            return False
        return queued.intent.item.event_id in {
            f"final:{authority.delegate_id}",
        } or queued.intent.item.event_id.startswith(f"observation:{authority.delegate_id}:")

    def _guard_activation_required(self, queued: _QueuedHostResponse) -> bool:
        return self._guard_activation_authorized(queued) and (
            self._provider_epoch_needing_activation == self.session.session_epoch
            or (
                self._provider_reconnect_source_epoch is not None
                and self._provider_reconnect_source_epoch != self.session.session_epoch
            )
        )

    def _clear_captions(self) -> None:
        """Blank dead-epoch speculative text on both roles after a reconnect."""
        self.session.reset_captions()
        if self._on_caption is not None:
            self._on_caption(CaptionFrame(role="assistant", text="", final=True))
            self._on_caption(CaptionFrame(role="user", text="", final=True))

    def _task_finished(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        failure = task.exception()
        if failure is not None:
            print(
                f"[realtime-diagnostic] task_failure type={type(failure).__name__}",
                flush=True,
            )
        if failure is not None or not self._stop.is_set():
            self._provider_failed = True
            self._urgent_host_response_owner = None
            self._clear_guard_preemption()
            self._stop.set()
            self._delivery_ready.set()

    @staticmethod
    def _report_delivery_failure(failure: RealtimeDeliveryError) -> None:
        print(
            f"[realtime-diagnostic] delivery_failure type={type(failure).__name__}",
            flush=True,
        )

    def _executor_manifest(self, channel: str) -> ExecutorManifest | None:
        adapter = self._runtime.executors.get(channel)
        return None if adapter is None else adapter.manifest

    def _executor_priority(self, channel: str | None) -> int:
        manifest = None if channel is None else self._executor_manifest(channel)
        return 50 if manifest is None else manifest.policy.priority

    def _executor_display_name(
        self,
        channel: str,
        *,
        manifest: ExecutorManifest | None = None,
    ) -> str:
        if channel == "codex":
            return "Codex"
        resolved = self._executor_manifest(channel) if manifest is None else manifest
        return channel if resolved is None else resolved.name

    def _delegate_summary(self, delegate_id: str, *, display_name: str = "Codex") -> str:
        snapshot = self.session.snapshot()
        for current_id, record in snapshot.active_delegates:
            if current_id == delegate_id:
                return record.summary
        return f"{display_name} background task"

    def _publish_codex_state(self) -> None:
        next_state: CodexState = (
            "running"
            if any(
                record.channel == "codex"
                for _delegate_id, record in self.session.snapshot().active_delegates
            )
            else "idle"
        )
        if next_state == self._codex_state:
            return
        self._codex_state = next_state
        try:
            self._on_codex_state(next_state)
        except Exception as exc:
            print(
                f"[realtime-diagnostic] codex_state_sink_failure type={type(exc).__name__}",
                flush=True,
            )
