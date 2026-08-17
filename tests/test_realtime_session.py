from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from itertools import count

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.realtime.playback import (
    PlaybackCompletion,
    PlaybackFrame,
    PlaybackGeneration,
    PlaybackRegistry,
)
from nova_audio_agent.realtime.protocol import (
    MAX_REALTIME_TEXT,
    HostContextItem,
    HostResponseIntent,
    ItemIdentity,
    RealtimeFrontBrainEvent,
    ResponseAudioDelta,
    ResponseStarted,
    ResponseTerminal,
    ResponseTranscriptFinal,
    SessionIdentity,
    ToolCallReady,
    UserSpeechEnded,
    UserSpeechStarted,
    UserTranscriptFailed,
    UserTranscriptFinal,
)
from nova_audio_agent.realtime.protocol import ResponseTranscriptDelta, UserTranscriptDelta
from nova_audio_agent.realtime.session import (
    MAX_CAPTION_CHARS,
    MAX_PREMAP_AUDIO_BYTES,
    CaptionFrame,
    DelegateRecord,
    RealtimeDeliveryError,
    RealtimeSession,
)


def ids(*values: str) -> Iterator[str]:
    return iter(values)


class FakeProvider:
    def __init__(self, actions: list[str]) -> None:
        self.actions = actions
        self.epoch = 0
        self.injected: list[HostContextItem] = []
        self.response_intents: list[HostResponseIntent] = []
        self.response_failures = 0
        self.confirmation_timeouts: list[float | None] = []
        self.user_activations: list[bool] = []
        self.connect_failure: BaseException | None = None
        self.injection_failure: BaseException | None = None

    async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
        if self.connect_failure is not None:
            raise self.connect_failure
        self.epoch += 1
        self.actions.append(f"connect:{len(tools)}")
        return SessionIdentity(epoch=self.epoch, provider_session_id=f"session-{self.epoch}")

    async def send_audio(self, pcm: bytes) -> None:
        self.actions.append(f"audio:{len(pcm)}")

    async def inject_host_item(
        self,
        item: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        if self.injection_failure is not None:
            raise self.injection_failure
        self.injected.append(item)
        self.confirmation_timeouts.append(confirmation_timeout)
        self.user_activations.append(as_user_activation)
        self.actions.append(f"inject:{item.host_item_id}")
        return ItemIdentity(
            session_epoch=self.epoch,
            host_item_id=item.host_item_id,
            provider_item_id=f"provider-{item.host_item_id}",
        )

    async def create_response(self, intent: HostResponseIntent) -> None:
        self.actions.append("create_response")
        if self.response_failures:
            self.response_failures -= 1
            raise RuntimeError("response failed")
        self.response_intents.append(intent)

    async def cancel_response(self, response_id: str) -> None:
        self.actions.append(f"cancel:{response_id}")

    def events(self) -> AsyncIterator[RealtimeFrontBrainEvent]:
        raise NotImplementedError

    async def close(self) -> None:
        self.actions.append("close")


def make_session(
    actions: list[str],
    *,
    frames: list[PlaybackFrame] | None = None,
    spoken: list[str] | None = None,
    deliveries: list[PlaybackCompletion] | None = None,
    alerts: list[tuple[str | None, int | None]] | None = None,
    clock: VirtualClock | None = None,
) -> tuple[RealtimeSession, FakeProvider]:
    frame_output = [] if frames is None else frames
    spoken_output = [] if spoken is None else spoken
    delivery_output = [] if deliveries is None else deliveries
    alert_output = [] if alerts is None else alerts
    id_values = ids(
        "generation-1",
        "utterance-1",
        "generation-2",
        "utterance-2",
        "host-recovery",
    )
    playback = PlaybackRegistry(
        id_factory=lambda: next(id_values),
        on_frame=frame_output.append,
        on_clear=lambda utterance_id, epoch: actions.append(f"clear:{utterance_id}:{epoch}"),
        on_alert=lambda utterance_id, epoch: alert_output.append((utterance_id, epoch)),
    )
    provider = FakeProvider(actions)

    def record_delivery(completion: PlaybackCompletion) -> None:
        delivery_output.append(completion)
        if completion.disposition == "spoken":
            spoken_output.append(completion.text)

    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=lambda: next(id_values),
        on_delivery=record_delivery,
        clock=VirtualClock() if clock is None else clock,
    )
    return session, provider


@pytest.mark.asyncio
async def test_reserved_confirmation_response_is_cancelled_before_audio_playback() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    session.arm_next_response_fence()

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="r-confirm"))
    assert actions[-1] == "cancel:r-confirm"
    assert session.current_generation is None


@pytest.mark.asyncio
async def test_reserved_confirmation_fence_emits_receipt_for_pending_host_event() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-item",
            event_id="confirmation-pending-event",
            content="pending",
        )
    )

    session.arm_next_response_fence()
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="reserved"))
    receipt = session.take_fence_interruption()

    assert receipt is not None
    assert receipt.event_ids == ("confirmation-pending-event",)


@pytest.mark.asyncio
async def test_failed_response_request_keeps_confirmed_intent_retryable() -> None:
    """Committing responded state before network success permanently drops acknowledgement."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-provider",
        content='{"state":"accepted"}',
    )
    intent = HostResponseIntent.delegation_acknowledgement(
        item=item,
        task_summary="运行完整 Python 测试",
    )
    assert await session.inject_tool_output(item)
    provider.response_failures = 1

    with pytest.raises(RuntimeError, match="response failed"):
        await session.deliver_host_response(intent)

    assert session.foreground_idle
    assert (await session.deliver_host_response(intent)).accepted
    assert provider.injected == [item]
    assert provider.response_intents == [intent]


@pytest.mark.asyncio
async def test_preemptive_host_response_forwards_confirmation_timeout() -> None:
    session, provider = make_session([])
    await session.connect(tools=())
    item = HostContextItem.final(
        host_item_id="guard-host",
        event_id="guard-event",
        content="guard",
    )

    delivery = await session.deliver_preemptive_host_response(
        HostResponseIntent.host_fact(item),
        confirmation_timeout=0.5,
    )

    assert delivery.accepted
    assert provider.confirmation_timeouts == [0.5]


@pytest.mark.asyncio
async def test_preemptive_host_response_only_uses_user_activation_when_explicit() -> None:
    session, provider = make_session([])
    await session.connect(tools=())
    first = HostContextItem.final(
        host_item_id="ordinary-host",
        event_id="ordinary-event",
        content="ordinary",
    )

    assert (
        await session.deliver_preemptive_host_response(HostResponseIntent.host_fact(first))
    ).accepted
    await session.accept(ResponseStarted(session_epoch=1, response_id="ordinary-response"))
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="ordinary-response",
            status="completed",
            reason="completed",
        )
    )
    second = HostContextItem.final(
        host_item_id="reconnect-guard",
        event_id="reconnect-guard-event",
        content="guard",
    )

    assert (
        await session.deliver_preemptive_host_response(
            HostResponseIntent.host_fact(second),
            as_user_activation=True,
        )
    ).accepted
    assert provider.user_activations == [False, True]


@pytest.mark.asyncio
async def test_preemptive_response_gate_runs_after_confirmation_and_keeps_fact_retryable() -> None:
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.final(
        host_item_id="guard-host",
        event_id="guard-event",
        content="guard",
    )
    intent = HostResponseIntent.host_fact(item)
    allowed = False

    first = await session.deliver_preemptive_host_response(
        intent,
        response_allowed=lambda: allowed,
    )

    assert not first.accepted
    assert first.injection_epoch == 1
    assert provider.injected == [item]
    assert provider.response_intents == []

    allowed = True
    second = await session.deliver_preemptive_host_response(
        intent,
        response_allowed=lambda: allowed,
    )

    assert second.accepted
    assert provider.injected == [item]
    assert provider.response_intents == [intent]


@pytest.mark.asyncio
async def test_concurrent_host_fact_and_tool_continuation_request_only_one_response() -> None:
    """A response.create awaiting provider I/O must reserve the pre-start window."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    progress = HostContextItem.progress(
        host_item_id="host-progress",
        event_id="event-progress",
        content="Codex 已开始处理这个任务。",
    )
    tool_output = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-provider",
        content='{"state":"accepted"}',
    )
    acknowledgement = HostResponseIntent.delegation_acknowledgement(
        item=tool_output,
        task_summary="写一个俄罗斯方块游戏",
    )
    assert await session.inject_tool_output(tool_output)

    first_create_entered = asyncio.Event()
    release_first_create = asyncio.Event()
    original_create_response = provider.create_response
    calls = 0

    async def create_response(intent: HostResponseIntent) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            first_create_entered.set()
            await release_first_create.wait()
        await original_create_response(intent)

    provider.create_response = create_response  # type: ignore[method-assign]
    progress_request = asyncio.create_task(session.deliver_host_item(progress))
    await first_create_entered.wait()
    continuation_request = asyncio.create_task(
        session.request_tool_continuation((acknowledgement,))
    )
    await asyncio.sleep(0)
    release_first_create.set()

    assert await progress_request is True
    assert await continuation_request == "retryable"
    assert calls == 1
    assert provider.response_intents == [HostResponseIntent.host_fact(progress)]


@pytest.mark.asyncio
async def test_tool_continuation_distinguishes_busy_from_permanent_deduplication() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-provider",
        content='{"state":"accepted"}',
    )
    intent = HostResponseIntent.tool_result(item)
    assert await session.inject_tool_output(item)

    assert await session.request_tool_continuation((intent,)) == "requested"
    assert await session.request_tool_continuation((intent,)) == "retryable"
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="continuation"))
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="completed",
            reason="completed",
        )
    )

    assert await session.request_tool_continuation((intent,)) == "rejected"


@pytest.mark.asyncio
async def test_terminal_response_accepts_final_transcript_until_renderer_delivery() -> None:
    """A final transcript arriving after provider terminal still belongs to queued playback."""
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, deliveries=deliveries)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )

    assert await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="response-1",
            text="最终文本",
        )
    )
    assert session.playback_done("utterance-1", 1, played_ms=100)
    assert deliveries[-1].text == "最终文本"


@pytest.mark.asyncio
async def test_tool_continuation_waits_for_renderer_playback_to_finish() -> None:
    """#49: a continuation must not fence pre-tool-call speech still audible on
    the renderer — it stays retryable until playback acks done."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="行，我帮你跑一下。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")

    assert await session.request_tool_continuation((intent,)) == "retryable"
    assert "cancel:original" not in actions
    assert not any(action.startswith("clear:") for action in actions)

    assert session.playback_done("utterance-1", 1, played_ms=420)
    assert await session.request_tool_continuation((intent,), origin_spoken=True) == "requested"
    assert _provider.response_intents[-1].origin_spoken is True


@pytest.mark.asyncio
async def test_newer_user_turn_keeps_origin_spoken_continuation_audible() -> None:
    """A newer user turn must supersede a pending continuation's silence authority."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done("utterance-1", 1, played_ms=420)

    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    assert await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")
    assert await session.request_tool_continuation((intent,), origin_spoken=True) == "requested"
    assert provider.response_intents[-1].origin_spoken is True

    assert await session.accept(UserSpeechStarted(1, "speech-2", "user-2"))
    assert await session.accept(UserTranscriptFinal(1, "user-2", "那先不用了"))
    assert await session.accept(UserSpeechEnded(1, "speech-2"))
    assert session.floor.state == "idle"
    assert await session.accept(ResponseStarted(1, "response-user-2")) is True
    assert await session.accept(ResponseAudioDelta(1, "response-user-2", b"\x00\x00")) is True
    assert "response-user-2" not in session._suppressed_response_ids


@pytest.mark.asyncio
async def test_explicit_origin_delivery_proof_marks_continuation_silent() -> None:
    """Session enforces the delivery proof supplied by the owning service ledger."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_started("utterance-1", 1)
    assert session.playback_done("utterance-1", 1)

    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")

    assert await session.request_tool_continuation((intent,), origin_spoken=True) == "requested"
    assert provider.response_intents[-1].origin_spoken is True


@pytest.mark.asyncio
async def test_continuation_after_interleaved_speech_keeps_the_spoken_ack() -> None:
    """Interleaved system speech must not revoke an explicit origin proof."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="好，我来看看。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    assert session.playback_done("utterance-1", 1, played_ms=360)

    assert await session.deliver_host_item(
        HostContextItem.final(
            host_item_id="host-alert",
            event_id="event-alert",
            content="监控到画面出现水杯。",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="alert-response"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="alert-response", pcm=b"\x02\x03")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="alert-response",
            status="completed",
            reason="completed",
        )
    )
    alert_generation = session.current_generation
    assert alert_generation is not None
    assert session.playback_done(
        alert_generation.utterance_id,
        alert_generation.generation_epoch,
        played_ms=280,
    )

    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")
    assert await session.request_tool_continuation((intent,), origin_spoken=True) == "requested"
    assert provider.response_intents[-1].origin_spoken is True


@pytest.mark.asyncio
async def test_continuation_without_origin_delivery_proof_keeps_ack_audible() -> None:
    """Without a service-owned delivery proof, Session keeps the acknowledgement."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="没问题，我处理。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done("utterance-1", 1, played_ms=0)

    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")

    assert await session.request_tool_continuation((intent,)) == "requested"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_fenced_unheard_origin_still_speaks_the_acknowledgement() -> None:
    """A fenced response cannot create proof, so the acknowledgement remains audible."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    await session.local_speech_onset("speech-user")
    assert session.playback_cleared("utterance-1", 1, 0)

    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")

    assert await session.request_tool_continuation((intent,)) == "requested"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_multi_ack_batch_never_claims_origin_spoken() -> None:
    """#55 review: one voiced confirmation cannot prove every task in a
    multi-tool batch was acknowledged — the merged continuation stays audible."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="行，我接着做。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done("utterance-1", 1, played_ms=510)

    intents = []
    for index in (1, 2):
        item = HostContextItem.tool_output(
            host_item_id=f"host-tool-{index}",
            event_id=f"event-tool-{index}",
            call_id=f"call-{index}",
            content='{"state":"accepted"}',
        )
        await session.inject_tool_output(item)
        intents.append(
            HostResponseIntent.delegation_acknowledgement(item=item, task_summary=f"任务{index}")
        )

    assert (
        await session.request_tool_continuation(tuple(intents), origin_spoken=True) == "requested"
    )
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_mixed_ack_and_sync_result_batch_never_claims_origin_spoken() -> None:
    """Review P1: origin speech can replace one acknowledgement, but it must
    not silence a synchronous result sharing the continuation batch."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="好，我帮你查一下。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done("utterance-1", 1, played_ms=470)

    ack_item = HostContextItem.tool_output(
        host_item_id="host-ack",
        event_id="event-ack",
        call_id="call-ack",
        content='{"state":"accepted"}',
    )
    result_item = HostContextItem.tool_output(
        host_item_id="host-result",
        event_id="event-result",
        call_id="call-result",
        content='{"summary":"still running"}',
    )
    assert await session.inject_tool_output(ack_item)
    assert await session.inject_tool_output(result_item)

    assert (
        await session.request_tool_continuation(
            (
                HostResponseIntent.delegation_acknowledgement(
                    item=ack_item,
                    task_summary="运行测试",
                ),
                HostResponseIntent.tool_result(result_item),
            ),
            origin_spoken=True,
        )
        == "requested"
    )
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_origin_spoken_continuation_discards_provider_audio_and_caption() -> None:
    """Live #55: Qwen may ignore the hard-silence instruction. Once the host
    proved the origin acknowledgement was heard, renderer output from that
    continuation must still be suppressed while its terminal completes the
    provider tool protocol."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    spoken: list[str] = []
    session, provider = make_session(actions, frames=frames, spoken=spoken)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="original",
            text="没问题，我来跑一下。",
        )
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done("utterance-1", 1, 1576)

    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    assert await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")
    assert await session.request_tool_continuation((intent,), origin_spoken=True) == "requested"
    assert provider.response_intents[-1].origin_spoken is True

    premap_transcript = ResponseTranscriptDelta(
        session_epoch=1,
        response_id="continuation",
        text="Codex 已接受",
    )
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x02\x03")
    )
    assert session.caption_for(premap_transcript) is None
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="continuation"))
    transcript = ResponseTranscriptDelta(
        session_epoch=1,
        response_id="continuation",
        text="Codex 已接受任务。",
    )
    assert session.caption_for(transcript) is None
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x04\x05")
    )
    assert not await session.accept(
        ResponseTranscriptFinal(
            session_epoch=1,
            response_id="continuation",
            text="Codex 已接受任务。",
        )
    )
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="completed",
            reason="completed",
        )
    )

    assert [frame.pcm for frame in frames] == [b"\x00\x01"]
    assert spoken == ["没问题，我来跑一下。"]
    assert session.current_generation is None
    assert session.foreground_idle


@pytest.mark.asyncio
async def test_silent_origin_continuation_keeps_the_spoken_ack() -> None:
    """#55: a tool call whose origin response produced no audio still gets the
    spoken acknowledgement — origin_spoken stays False."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="silent-origin"))
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent-origin",
            status="completed",
            reason="completed",
        )
    )
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    intent = HostResponseIntent.delegation_acknowledgement(item=item, task_summary="运行测试")

    assert await session.request_tool_continuation((intent,)) == "requested"
    assert provider.response_intents[-1].origin_spoken is False


@pytest.mark.asyncio
async def test_new_provider_response_audio_fences_unacked_older_generation() -> None:
    """A provider-initiated response's first PCM still fences an older renderer
    generation that was never acked — #49 moved continuations off this path but
    kept the floor behavior for provider-initiated speech."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    original = session.current_generation
    assert original is not None
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )

    await session.accept(ResponseStarted(session_epoch=1, response_id="followup"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="followup", pcm=b"\x02\x03")
    )

    assert f"clear:{original.utterance_id}:{original.generation_epoch}" in actions
    current = session.current_generation
    assert current is not None
    assert current.response_id == "followup"
    assert [frame.pcm for frame in frames] == [b"\x00\x01", b"\x02\x03"]


@pytest.mark.asyncio
async def test_host_created_response_cannot_dispatch_recursive_tools() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    progress = HostContextItem.progress(
        host_item_id="host-progress",
        event_id="event-progress",
        content="Codex 已开始处理这个任务。",
    )
    assert await session.deliver_host_item(progress)
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="progress-response"))

    accepted = await session.accept(
        ToolCallReady(
            session_epoch=1,
            call_id="call-recursive",
            item_id="item-recursive",
            name="codex__status",
            arguments={"delegate_id": "d-1"},
            response_id="progress-response",
        )
    )

    assert accepted is False


@pytest.mark.asyncio
async def test_user_transcript_reserves_foreground_until_automatic_response_starts() -> None:
    """A host fact must not join the user's response in the pre-start gap."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserTranscriptFinal(
            session_epoch=1,
            item_id="status-question",
            text="现在做到哪了？",
        )
    )
    assert not session.foreground_idle

    assert await session.accept(ResponseStarted(session_epoch=1, response_id="status-response"))
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="status-response",
            status="completed",
            reason="done",
        )
    )
    assert session.foreground_idle


@pytest.mark.asyncio
async def test_injected_and_responded_replay_windows_are_bounded() -> None:
    """Per-event replay bookkeeping must not grow for the desktop process lifetime."""
    actions: list[str] = []
    serial = count(1)
    playback = PlaybackRegistry(
        id_factory=lambda: f"playback-{next(serial)}",
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    provider = FakeProvider(actions)
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=lambda: f"host-{next(serial)}",
        on_spoken=lambda _text: None,
    )
    await session.connect(tools=())

    for index in range(501):
        item = HostContextItem.tool_output(
            host_item_id=f"host-tool-{index}",
            event_id=f"event-tool-{index}",
            call_id=f"call-{index}",
            content='{"state":"accepted"}',
        )
        intent = HostResponseIntent.delegation_acknowledgement(
            item=item,
            task_summary=f"任务 {index}",
        )
        assert await session.inject_tool_output(item)
        assert (await session.deliver_host_response(intent)).accepted
        response_id = f"response-{index}"
        assert await session.accept(ResponseStarted(session_epoch=1, response_id=response_id))
        assert await session.accept(
            ResponseTerminal(
                session_epoch=1,
                response_id=response_id,
                status="cancelled",
                reason="test",
            )
        )

    assert len(session._injected_event_epochs) == 500
    assert len(session._responded_event_ids) == 500


@pytest.mark.asyncio
async def test_pending_tool_output_confirmations_survive_bounded_replay_pruning() -> None:
    """A maximum-size continuation batch cannot evict its own first confirmation."""
    actions: list[str] = []
    serial = count(1)
    playback = PlaybackRegistry(
        id_factory=lambda: f"playback-{next(serial)}",
        on_frame=lambda _frame: None,
        on_clear=lambda _utterance_id, _epoch: None,
    )
    provider = FakeProvider(actions)
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=lambda: f"host-{next(serial)}",
        on_spoken=lambda _text: None,
    )
    await session.connect(tools=())
    intents: list[HostResponseIntent] = []
    for index in range(532):
        item = HostContextItem.tool_output(
            host_item_id=f"host-tool-{index}",
            event_id=f"event-tool-{index}",
            call_id=f"call-{index}",
            content='{"state":"accepted"}',
        )
        assert await session.inject_tool_output(item)
        intents.append(HostResponseIntent.tool_result(item))

    assert await session.request_tool_continuation(tuple(intents)) == "requested"

    assert provider.response_intents[0].kind == "tool_result"
    assert len(session._injected_event_epochs) == 500
    assert len(session._responded_event_ids) == 500


@pytest.mark.asyncio
async def test_unknown_response_pcm_never_reaches_playback() -> None:
    """Unknown provider response IDs must not acquire a renderer generation implicitly."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())

    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="foreign", pcm=b"\x00\x01")
    )

    assert frames == []


@pytest.mark.asyncio
async def test_provider_started_foreground_response_opens_on_first_audio() -> None:
    """Smart-turn responses are provider-created and have no host-item creation window."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())

    assert await session.accept(ResponseStarted(session_epoch=1, response_id="foreground-1"))
    assert session.current_generation is None
    assert await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="foreground-1",
            pcm=b"\x00\x01",
        )
    )

    assert session.current_generation is not None
    assert frames[0].pcm == b"\x00\x01"


@pytest.mark.asyncio
async def test_overlapping_response_start_cannot_create_a_playable_turn() -> None:
    """A rejected overlapping ID cannot later steal a continuation window."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-a"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-a", pcm=b"\x00\x01")
    )
    original_generation = session.current_generation
    assert original_generation is not None

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="response-b"))
    assert session.provider_turn_was_fenced("response-b")
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-a",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done(
        original_generation.utterance_id, original_generation.generation_epoch
    )
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    assert await session.inject_tool_output(item)
    assert (
        await session.request_tool_continuation(
            (
                HostResponseIntent.delegation_acknowledgement(
                    item=item,
                    task_summary="运行测试",
                ),
            )
        )
        == "requested"
    )

    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-b", pcm=b"\x02\x03")
    )
    assert session.current_generation is None
    assert [frame.pcm for frame in frames] == [b"\x00\x01"]
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-c"))
    assert session.active_provider_response_id == "response-c"
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-c", pcm=b"\x04\x05")
    )
    assert session.current_generation is not None
    assert session.current_generation.response_id == "response-c"
    assert [frame.pcm for frame in frames] == [b"\x00\x01", b"\x04\x05"]


@pytest.mark.asyncio
async def test_tool_only_provider_response_returns_foreground_to_idle() -> None:
    """A tool-call-only response has no renderer acknowledgement to release its response slot."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    await session.accept(ResponseStarted(session_epoch=1, response_id="tool-response"))
    assert session.foreground_idle is False

    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="tool-response",
            status="completed",
            reason="completed",
        )
    )
    assert session.foreground_idle is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "replayed_status"),
    [
        ("completed", "failed"),
        ("cancelled", "completed"),
        ("failed", "cancelled"),
    ],
)
async def test_duplicate_response_terminal_is_idempotent(
    status: str,
    replayed_status: str,
) -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    terminal = ResponseTerminal(
        session_epoch=1,
        response_id="response-1",
        status=status,  # type: ignore[arg-type]
        reason="provider_terminal",
    )
    replayed_terminal = ResponseTerminal(
        session_epoch=1,
        response_id="response-1",
        status=replayed_status,  # type: ignore[arg-type]
        reason="replayed_provider_terminal",
    )
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    assert await session.accept(terminal)
    assert await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-after-terminal", text="继续")
    )
    before = (
        session.provider_turn_phase("response-1"),
        session.foreground_idle,
        session.floor,
        session.snapshot(),
        session.response_event_ids("response-1"),
        tuple(actions),
    )

    assert not await session.accept(replayed_terminal)

    assert (
        session.provider_turn_phase("response-1"),
        session.foreground_idle,
        session.floor,
        session.snapshot(),
        session.response_event_ids("response-1"),
        tuple(actions),
    ) == before


@pytest.mark.asyncio
async def test_audio_just_before_response_start_is_buffered_in_creation_window() -> None:
    """Dropping early provider PCM would clip the first audible response packet."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )

    assert await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="response-progress",
            pcm=b"\x00\x01",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-progress"))

    assert frames == [
        PlaybackFrame(
            utterance_id="utterance-1",
            generation_epoch=1,
            sequence=0,
            pcm=b"\x00\x01",
        )
    ]


@pytest.mark.asyncio
async def test_user_onset_fences_preplay_response_window() -> None:
    """A response known only by early PCM must still be cancelled before it opens playback."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="response-progress",
            pcm=b"\x00\x01",
        )
    )

    await session.local_speech_onset("speech-user")

    assert actions[-1] == "cancel:response-progress"
    assert frames == []
    assert session.snapshot().interrupted_event_ids == ("event-progress",)
    assert (
        await session.accept(ResponseStarted(session_epoch=1, response_id="response-progress"))
        is False
    )


@pytest.mark.asyncio
async def test_barge_in_allows_later_response_after_first_prestart_request_cancels() -> None:
    """A later response waits until the first pre-start request reaches terminal."""
    actions: list[str] = []
    spoken: list[str] = []
    session, _provider = make_session(actions, spoken=spoken)
    await session.connect(tools=())
    first = HostContextItem.tool_output(
        host_item_id="host-tool-1",
        event_id="event-tool-1",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    second = HostContextItem.tool_output(
        host_item_id="host-tool-2",
        event_id="event-tool-2",
        call_id="call-2",
        content='{"state":"accepted"}',
    )
    first_intent = HostResponseIntent.delegation_acknowledgement(
        item=first,
        task_summary="first task",
    )
    second_intent = HostResponseIntent.delegation_acknowledgement(
        item=second,
        task_summary="second task",
    )
    assert await session.inject_tool_output(first)
    assert await session.inject_tool_output(second)
    assert await session.request_tool_continuation((first_intent,)) == "requested"
    assert await session.request_tool_continuation((second_intent,)) == "retryable"
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-first", pcm=b"\x00\x01")
    )

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    await session.local_speech_onset("speech-local-uuid")

    assert actions[-1] == "cancel:response-first"
    assert session.snapshot().interrupted_event_ids == ("event-tool-1",)
    assert session.active_provider_response_id == "response-first"
    assert session.provider_turn_phase("response-first") == "cancel_requested"
    assert session.provider_turn_was_fenced("response-first")
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="response-first"))
    assert session.current_generation is None
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-first",
            status="cancelled",
            reason="turn_detected",
        )
    )
    assert session.active_provider_response_id is None
    assert session.provider_turn_phase("response-first") == "cancelled"
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    assert await session.request_tool_continuation((second_intent,)) == "requested"
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-second"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-second", pcm=b"\x02\x03")
    )
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-second",
            status="completed",
            reason="completed",
        )
    )
    generation = session.current_generation
    assert generation is not None

    assert session.playback_done(generation.utterance_id, generation.generation_epoch)
    assert session.snapshot().spoken_event_ids == ("event-tool-2",)
    assert spoken == [""]


@pytest.mark.asyncio
async def test_item_confirmation_precedes_host_approved_response() -> None:
    """Creating a response before confirmed injection could speak stale or missing progress."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )

    assert actions == ["connect:0", "inject:host-progress", "create_response"]


@pytest.mark.asyncio
async def test_barge_in_fences_before_cancel_and_keeps_delegate_running() -> None:
    """Reordering local clear after network cancel would keep stale audio audible."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    session.register_delegate("delegate-1", summary="Build Tetris", state="running")
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-progress"))
    await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="response-progress",
            pcm=b"\x00\x01",
        )
    )

    await session.local_speech_onset("speech-local-uuid")

    assert actions[-2:] == ["clear:utterance-1:1", "cancel:response-progress"]
    assert session.delegate_state("delegate-1") == "running"
    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    assert session.floor.state == "user_speaking"
    await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="user-item")
    )
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_host_preempt_cancels_provider_but_keeps_old_audio_until_switch() -> None:
    """Clearing at Guard-hit time would expose the whole provider handoff as silence."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-event",
            event_id="host-event",
            content="Urgent host fact.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="assistant-1"))
    await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="assistant-1",
            pcm=b"\x00\x01",
        )
    )
    generation = session.current_generation
    assert generation is not None
    snapshot = session.snapshot()

    assert await session.host_preempt()

    assert actions[-1] == "cancel:assistant-1"
    assert not any(action.startswith("clear:") for action in actions)
    assert session.current_generation == generation
    assert session.floor.state == "idle"
    assert session.snapshot() == snapshot
    assert not await session.host_preempt()
    assert actions.count("cancel:assistant-1") == 1


@pytest.mark.asyncio
async def test_soft_cancelled_terminal_drains_as_interrupted_without_spoken() -> None:
    """A cancelled old response may drain PCM but cannot become a spoken completion."""
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    spoken: list[str] = []
    session, _provider = make_session(actions, deliveries=deliveries, spoken=spoken)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="old-item",
            event_id="old-event",
            content="old speech",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    generation = session.current_generation
    assert generation is not None
    assert session.playback_started(generation.utterance_id, generation.generation_epoch)
    assert await session.host_preempt()

    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="old",
            status="cancelled",
            reason="client_cancelled",
        )
    )

    assert session.current_generation == generation
    assert session.provider_idle
    assert not session.foreground_idle
    assert session.playback_done(generation.utterance_id, generation.generation_epoch, 20)
    assert spoken == []
    assert deliveries[-1].disposition == "interrupted"
    assert session.snapshot().spoken_event_ids == ()
    assert session.snapshot().interrupted_event_ids == ("old-event",)


@pytest.mark.asyncio
async def test_completed_soft_cancel_allows_preemptive_delivery_while_old_drains() -> None:
    """The idle provider slot may start Guard while ordinary facts still wait for playback."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="old-item",
            event_id="old-event",
            content="old speech",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    assert await session.host_preempt()
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="old",
            status="completed",
            reason="completed",
        )
    )
    urgent = HostResponseIntent.host_fact(
        HostContextItem.final(
            host_item_id="guard-item",
            event_id="guard-event",
            content="guard alert",
        )
    )

    assert session.provider_idle
    with pytest.raises(RealtimeDeliveryError, match="foreground became busy"):
        await session.deliver_host_response(urgent)
    assert (await session.deliver_preemptive_host_response(urgent)).accepted
    assert provider.injected[-1].event_id == "guard-event"
    assert session.current_generation == old_generation

    assert await session.accept(ResponseStarted(session_epoch=1, response_id="guard"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="guard", pcm=b"\x02\x03")
    )

    assert actions[-1] == "clear:utterance-1:1"
    assert frames[-1].utterance_id == "utterance-2"
    assert frames[-1].sequence == 0
    assert session.current_generation is not None
    assert session.current_generation.response_id == "guard"


@pytest.mark.asyncio
async def test_guard_first_audio_disarms_deadline_after_old_audio_drained() -> None:
    """A stale deadline cannot beep after both generations have naturally moved on."""
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="old-item",
            event_id="old-event",
            content="old speech",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    assert session.playback_started(
        old_generation.utterance_id,
        old_generation.generation_epoch,
    )
    assert await session.host_preempt()
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="old",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        20,
    )

    urgent = HostResponseIntent.host_fact(
        HostContextItem.final(
            host_item_id="guard-item",
            event_id="guard-event",
            content="guard alert",
        )
    )
    assert (await session.deliver_preemptive_host_response(urgent)).accepted
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="guard"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="guard", pcm=b"\x02\x03")
    )
    guard_generation = session.current_generation
    assert guard_generation is not None
    assert session.playback_started(
        guard_generation.utterance_id,
        guard_generation.generation_epoch,
    )
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="guard",
            status="completed",
            reason="completed",
        )
    )
    assert session.playback_done(
        guard_generation.utterance_id,
        guard_generation.generation_epoch,
        20,
    )

    assert not session.expire_host_preempt(old_generation)
    assert alerts == []


@pytest.mark.asyncio
async def test_expired_host_preempt_alerts_only_the_captured_old_generation() -> None:
    """A late deadline must never clear the replacement generation."""
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="old-item",
            event_id="old-event",
            content="old speech",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    assert await session.host_preempt()

    assert session.expire_host_preempt(old_generation)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]
    assert session.current_generation is None
    assert not session.expire_host_preempt(old_generation)


@pytest.mark.asyncio
async def test_guard_deadline_fences_captured_generation_when_provider_response_differs() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="renderer-a"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="renderer-a", pcm=b"\x00\x01")
    )
    generation_a = session.current_generation
    assert generation_a is not None
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="renderer-a",
            status="completed",
            reason="completed",
        )
    )
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="provider-b"))

    assert await session.host_preempt()
    assert actions[-1] == "cancel:provider-b"
    assert session.provider_turn_phase("provider-b") == "cancel_requested"

    assert session.expire_host_preempt(generation_a)
    assert alerts == [(generation_a.utterance_id, generation_a.generation_epoch)]
    assert session.current_generation is None
    assert not session.expire_host_preempt(generation_a)


@pytest.mark.asyncio
async def test_guard_deadline_never_clears_replacement_generation() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="renderer-a"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="renderer-a", pcm=b"\x00\x01")
    )
    generation_a = session.current_generation
    assert generation_a is not None
    assert await session.host_preempt()
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="renderer-a",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    await session.local_speech_onset("local-onset")
    generation_c = session._playback.open_response(
        session_epoch=1,
        response_id="replacement-c",
    )

    assert session.expire_host_preempt(generation_a)
    assert session.current_generation == generation_c
    assert alerts == []


@pytest.mark.asyncio
async def test_unbound_prestart_guard_deadline_never_fences_replacement_generation() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    assert await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response is waiting to start",
        )
    )
    assert await session.host_preempt()
    generation_c = session._playback.open_response(
        session_epoch=1,
        response_id="replacement-c",
    )

    assert session.expire_host_preempt(None)
    assert session.current_generation == generation_c
    assert alerts == []
    assert not any(action.startswith("clear:") for action in actions)


@pytest.mark.asyncio
async def test_bound_prestart_guard_deadline_never_fences_replacement_generation() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    assert await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-item",
            event_id="ordinary-event",
            content="ordinary response is waiting to start",
        )
    )
    assert await session.host_preempt()
    assert not await session.accept(
        ResponseStarted(session_epoch=1, response_id="cancelled-response")
    )
    assert session.provider_turn_phase("cancelled-response") == "cancel_requested"
    generation_c = session._playback.open_response(
        session_epoch=1,
        response_id="replacement-c",
    )

    assert session.expire_host_preempt(None)
    assert session.current_generation == generation_c
    assert alerts == []
    assert not any(action.startswith("clear:") for action in actions)


@pytest.mark.asyncio
async def test_host_preempt_refuses_while_user_is_speaking() -> None:
    """The session guard must preserve an observable assistant response and user floor."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-floor",
            event_id="host-floor",
            content="Assistant is still speaking.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="assistant-floor"))
    await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="assistant-floor",
            pcm=b"\x00\x01",
        )
    )
    generation = session.current_generation
    assert generation is not None
    await session.accept(UserSpeechStarted(session_epoch=1, speech_id="user-1"))

    assert not await session.host_preempt()
    assert session.current_generation == generation
    assert not any(action.startswith("cancel:") for action in actions)
    assert not any(action.startswith("clear:") for action in actions)
    assert session.floor.state == "user_speaking"


@pytest.mark.asyncio
async def test_host_preempt_does_not_claim_awaiting_user_response_as_fenced() -> None:
    """A transcript-to-ResponseStarted gap has no observable response to cancel yet."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-item", text="Tell me more")
    )

    assert not await session.host_preempt()
    assert not any(action.startswith("cancel:") for action in actions)
    assert session.foreground_idle is False


@pytest.mark.asyncio
async def test_local_prestart_fence_exposes_abandoned_host_event_once() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )

    await session.local_speech_onset("local")

    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.session_epoch == 1
    assert receipt.event_ids == ("final:urgent",)
    assert session.take_fence_interruption() is None
    assert session.snapshot().interrupted_event_ids == ("final:urgent",)


@pytest.mark.asyncio
async def test_rejected_pre_map_audio_exposes_fenced_host_event() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )
    await session.local_speech_onset("local")

    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="dropped", pcm=b"\x00\x01")
    )
    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.session_epoch == 1
    assert receipt.event_ids == ("final:urgent",)


@pytest.mark.asyncio
async def test_pre_map_audio_during_user_floor_exposes_fenced_host_event() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )
    assert await session.accept(UserSpeechStarted(session_epoch=1, speech_id="user"))

    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="dropped", pcm=b"\x00\x01")
    )

    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.session_epoch == 1
    assert receipt.event_ids == ("final:urgent",)


@pytest.mark.asyncio
async def test_prestart_fence_exposes_receipt_when_provider_only_sends_unknown_terminal() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )
    await session.local_speech_onset("local")

    assert not await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="dropped",
            status="cancelled",
            reason="provider_dropped",
        )
    )
    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.session_epoch == 1
    assert receipt.event_ids == ("final:urgent",)


@pytest.mark.asyncio
async def test_unknown_terminal_for_prestart_fence_allows_later_host_response() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )
    await session.local_speech_onset("local")

    assert not await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="dropped",
            status="cancelled",
            reason="provider_dropped",
        )
    )
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="ordinary-host-item",
            event_id="final:ordinary",
            content="ordinary response",
        )
    )

    assert await session.accept(ResponseStarted(session_epoch=1, response_id="ordinary"))


@pytest.mark.asyncio
async def test_prestart_fence_arm_keeps_foreground_busy_until_consumed() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )

    await session.local_speech_onset("local")

    receipt = session.take_fence_interruption()
    assert receipt is not None
    assert receipt.event_ids == ("final:urgent",)
    assert session.foreground_idle is False

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="doomed"))
    assert session.take_fence_interruption() is None
    assert session.foreground_idle is False
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="doomed",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    assert session.foreground_idle is True


@pytest.mark.asyncio
async def test_fence_consumption_by_unknown_terminal_frees_foreground_without_receipt() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )
    await session.local_speech_onset("local")
    assert session.take_fence_interruption() is not None
    assert session.foreground_idle is False

    assert not await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="dropped",
            status="cancelled",
            reason="provider_dropped",
        )
    )

    assert session.take_fence_interruption() is None
    assert session.foreground_idle is True


@pytest.mark.asyncio
async def test_unknown_terminal_without_fence_leaves_live_pending_untouched() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="urgent-host-item",
            event_id="final:urgent",
            content="urgent alert",
        )
    )

    assert not await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="foreign",
            status="cancelled",
            reason="replayed",
        )
    )

    assert session.foreground_idle is False
    assert session.take_fence_interruption() is None
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="urgent-1"))
    assert session.response_event_ids("urgent-1") == ("final:urgent",)


@pytest.mark.asyncio
async def test_local_onset_fences_requested_continuation_start_first() -> None:
    """response.create is in flight but response.created has not arrived: a barge-in
    in that window must fence the upcoming response, not let it open the renderer
    while the user is speaking (pre-start window, provider VAD not yet triggered)."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    intent = HostResponseIntent.delegation_acknowledgement(
        item=item,
        task_summary="运行完整 Python 测试",
    )
    assert await session.inject_tool_output(item)
    assert await session.request_tool_continuation((intent,)) == "requested"

    await session.local_speech_onset("speech-local-uuid")

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="continuation"))
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x00\x01")
    )
    assert session.current_generation is None
    assert not frames
    assert "cancel:continuation" in actions
    assert session.snapshot().interrupted_event_ids == ("event-tool",)
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="continuation",
            status="cancelled",
            reason="turn_detected",
        )
    )
    del provider


@pytest.mark.asyncio
async def test_local_onset_fences_requested_continuation_delta_first() -> None:
    """Same pre-start window, but the fenced response's first event is audio: the
    delta must not pre-map into a playable generation after the barge-in."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    first = HostContextItem.tool_output(
        host_item_id="host-tool-1",
        event_id="event-tool-1",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    first_intent = HostResponseIntent.delegation_acknowledgement(
        item=first,
        task_summary="first task",
    )
    assert await session.inject_tool_output(first)
    assert await session.request_tool_continuation((first_intent,)) == "requested"

    await session.local_speech_onset("speech-local-uuid")

    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="continuation", pcm=b"\x00\x01")
    )
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="continuation"))
    assert session.current_generation is None
    assert not frames
    assert "cancel:continuation" in actions


@pytest.mark.asyncio
async def test_oversized_first_delta_cannot_escape_a_later_prestart_fence() -> None:
    """An overflow-rejected delta must not create the turn that later bypasses
    the one-shot pre-start fence or leaves that fence armed for a live response."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    assert await session.deliver_host_item(
        HostContextItem.final(
            host_item_id="host-doomed",
            event_id="final:doomed",
            content="doomed response",
        )
    )

    assert not await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="doomed",
            pcm=b"x" * (MAX_PREMAP_AUDIO_BYTES + 2),
        )
    )
    await session.local_speech_onset("barge-in")

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="doomed"))
    assert "cancel:doomed" in actions
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="doomed",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert await session.deliver_host_item(
        HostContextItem.final(
            host_item_id="host-live",
            event_id="final:live",
            content="live response",
        )
    )
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="live"))
    assert session.response_event_ids("live") == ("final:live",)


@pytest.mark.asyncio
async def test_recorded_turn_meeting_an_armed_fence_is_rejected_not_fatal() -> None:
    """A provider that interleaves two unmapped response streams can leave an
    active recorded turn alive when a barge-in later arms the one-shot fence.
    That protocol violation must reject the conflicting start, keep the fence
    armed for the next unowned start, and never escape as an AssertionError."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    assert await session.deliver_host_item(
        HostContextItem.final(
            host_item_id="host-doomed",
            event_id="final:doomed",
            content="doomed response",
        )
    )
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="resp-a", pcm=b"\x00\x01")
    )
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="resp-b"))
    await session.local_speech_onset("barge-in")
    assert session.take_fence_interruption() is not None

    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="resp-a"))
    assert session.provider_turn_phase("resp-a") == "cancel_requested"
    assert session.provider_turn_was_fenced("resp-a")
    assert "cancel:resp-a" in actions
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="resp-a", pcm=b"\x02\x03")
    )

    assert session.take_fence_interruption() is None
    assert session.foreground_idle is False
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="resp-c"))
    assert session.foreground_idle is False
    assert "cancel:resp-c" in actions
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="resp-c",
            status="cancelled",
            reason="client_cancelled",
        )
    )
    assert session.foreground_idle is True

    assert await session.deliver_host_item(
        HostContextItem.final(
            host_item_id="host-live",
            event_id="final:live",
            content="live response",
        )
    )
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="resp-live"))
    assert session.response_event_ids("resp-live") == ("final:live",)


@pytest.mark.asyncio
async def test_provider_speech_end_releases_floor_after_local_onset_interleaves() -> None:
    """Live 2026-08-05 regression: a local onset UUID overwrote the provider speech
    ownership, the provider end no longer matched, the floor stayed user_speaking,
    and every acknowledgement audio delta was rejected."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    await session.local_speech_onset("speech-local-uuid")
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )

    assert session.floor.state == "idle"
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="acknowledgement"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="acknowledgement", pcm=b"\x00\x01")
    )
    generation = session.current_generation
    assert generation is not None
    assert generation.response_id == "acknowledgement"
    assert frames


@pytest.mark.asyncio
async def test_local_onset_alone_does_not_take_user_speech_floor() -> None:
    """Only provider VAD owns the user_speaking floor; the local detector is a
    barge-in signal and must not block provider-gated response audio."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    await session.local_speech_onset("speech-local-uuid")

    assert session.floor.state == "idle"
    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    assert session.floor.state == "user_speaking"
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_stale_provider_speech_end_does_not_release_newer_speech() -> None:
    """A late provider end for an older utterance must not end the current one."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-old", provider_item_id="item-1")
    )
    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-new", provider_item_id="item-2")
    )
    assert not await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-old", provider_item_id="item-1")
    )
    assert session.floor.state == "user_speaking"
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-new", provider_item_id="item-2")
    )
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_repeated_local_onsets_do_not_stack_cancels_or_block_release() -> None:
    """The renderer re-arms after 180ms of silence, so one utterance can emit
    several onsets; they must not repeat provider cancels or wedge the floor."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    assert not await session.accept(ResponseStarted(session_epoch=1, response_id="stray-response"))
    await session.local_speech_onset("speech-local-1")
    await session.local_speech_onset("speech-local-2")
    await session.local_speech_onset("speech-local-3")

    assert actions.count("cancel:stray-response") == 1
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_provider_speech_start_takes_floor_without_fencing_renderer() -> None:
    """Provider speech_started only takes the floor. It must not fence the renderer:
    marking the origin turn locally_fenced would supersede a ToolCallReady still owned
    by that response (user barge-in != abandon tool protocol state). The local onset
    detector is the renderer barge-in path; a soft overlap the local detector misses
    keeps playing — a known parity gap with the reference implementation."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-progress"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-progress", pcm=b"\x00\x01")
    )
    assert session.current_generation is not None

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )

    assert session.floor.state == "user_speaking"
    assert session.current_generation is not None
    assert session.snapshot().interrupted_event_ids == ()
    assert not session.provider_turn_was_fenced("response-progress")


@pytest.mark.asyncio
async def test_barge_in_cancels_active_provider_not_older_renderer() -> None:
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="original"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="original", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="original",
            status="completed",
            reason="completed",
        )
    )
    item = HostContextItem.tool_output(
        host_item_id="host-tool",
        event_id="event-tool",
        call_id="call-1",
        content='{"state":"accepted"}',
    )
    await session.inject_tool_output(item)
    await session.request_tool_continuation(
        (
            HostResponseIntent.delegation_acknowledgement(
                item=item,
                task_summary="运行测试",
            ),
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="continuation"))

    await session.local_speech_onset("speech-user")

    assert actions[-2:] == ["clear:utterance-1:1", "cancel:continuation"]
    assert session.active_provider_response_id == "continuation"
    assert session.provider_turn_phase("continuation") == "cancel_requested"
    assert not await session.accept(
        ResponseAudioDelta(
            session_epoch=1,
            response_id="continuation",
            pcm=b"\x02\x03",
        )
    )
    assert [frame.pcm for frame in frames] == [b"\x00\x01"]


@pytest.mark.asyncio
async def test_pending_response_opens_no_renderer_until_first_pcm() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.progress(
        host_item_id="host-progress",
        event_id="event-progress",
        content="Codex is working.",
    )
    await session.deliver_host_item(item)
    await session.accept(ResponseStarted(session_epoch=1, response_id="silent"))

    assert session.current_generation is None
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="silent",
            status="completed",
            reason="completed",
        )
    )
    assert session.foreground_idle


@pytest.mark.asyncio
async def test_reconnect_injects_current_snapshot_without_replaying_dispositions() -> None:
    """Recreating response intents on reconnect would duplicate spoken or interrupted progress."""
    actions: list[str] = []
    spoken: list[str] = []
    session, provider = make_session(actions, spoken=spoken)
    await session.connect(tools=())
    session.register_delegate("delegate-1", summary="Build Tetris", state="running")

    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress-1",
            event_id="event-progress-1",
            content="First milestone.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="First milestone.")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )
    generation = session.current_generation
    assert generation is not None
    session.playback_done(generation.utterance_id, generation.generation_epoch)

    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress-2",
            event_id="event-progress-2",
            content="Second milestone.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-2"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-2", pcm=b"\x00\x01")
    )
    await session.local_speech_onset("speech-user")

    snapshot = session.snapshot()
    assert snapshot.version > 0
    assert snapshot.spoken_event_ids == ("event-progress-1",)
    assert snapshot.interrupted_event_ids == ("event-progress-2",)
    assert snapshot.active_delegates == (
        ("delegate-1", DelegateRecord(summary="Build Tetris", state="running")),
    )

    await session.reconnect(tools=())

    assert provider.epoch == 2
    assert provider.injected[-1].kind == "recovery"
    assert "Build Tetris" in provider.injected[-1].content
    assert "event-progress-1" not in provider.injected[-1].content
    assert "event-progress-2" not in provider.injected[-1].content
    assert actions[-3:] == ["close", "connect:0", f"inject:{provider.injected[-1].host_item_id}"]
    assert spoken == ["First milestone."]


@pytest.mark.asyncio
async def test_reconnect_cannot_split_host_item_and_response_create_across_epochs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A confirmed old-socket item must never create its response on the replacement socket."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.final(
        host_item_id="host-guard",
        event_id="final:guard",
        content="检测到白纸。",
    )
    intent = HostResponseIntent.host_fact(item)
    injection_confirmed = asyncio.Event()
    release_injection = asyncio.Event()
    original_inject = provider.inject_host_item

    async def pause_after_old_epoch_confirmation(
        pending: HostContextItem,
        *,
        confirmation_timeout: float | None = None,
        as_user_activation: bool = False,
    ) -> ItemIdentity:
        identity = await original_inject(
            pending,
            confirmation_timeout=confirmation_timeout,
            as_user_activation=as_user_activation,
        )
        injection_confirmed.set()
        await release_injection.wait()
        return identity

    monkeypatch.setattr(provider, "inject_host_item", pause_after_old_epoch_confirmation)
    delivery = asyncio.create_task(session.deliver_host_response(intent))
    await asyncio.wait_for(injection_confirmed.wait(), timeout=0.2)
    reconnect = asyncio.create_task(session.reconnect(tools=()))
    await asyncio.sleep(0)

    assert not reconnect.done()
    release_injection.set()
    assert (await delivery).accepted
    await reconnect

    assert provider.response_intents == [intent]
    assert actions.index("create_response") < actions.index("close")


@pytest.mark.asyncio
async def test_guard_reconnect_keeps_old_audio_until_new_epoch_first_frame() -> None:
    """Guard reconnect must not clear its captured renderer generation during socket replacement."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    session, provider = make_session(actions, frames=frames)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old-response"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="old-response", pcm=b"\x00\x01")
    )
    old_generation = session.current_generation
    assert old_generation is not None
    assert session.playback_started(
        old_generation.utterance_id,
        old_generation.generation_epoch,
    )

    await session.reconnect_for_guard(
        tools=(),
        old_generation=old_generation,
        confirmation_timeout=0.5,
    )

    assert provider.epoch == 2
    assert not [action for action in actions if action.startswith("clear:")]
    assert session.current_generation == old_generation
    assert session.floor.state == "agent_speaking"
    assert session.floor.utterance_id == old_generation.utterance_id
    assert provider.confirmation_timeouts[-1] == 0.5
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="old-response", pcm=b"\x02\x03")
    )
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="guard-response"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=2, response_id="guard-response", pcm=b"\x04\x05")
    )

    assert (
        actions.count(f"clear:{old_generation.utterance_id}:{old_generation.generation_epoch}") == 1
    )
    assert [frame.pcm for frame in frames] == [b"\x00\x01", b"\x04\x05"]
    new_generation = session.current_generation
    assert new_generation is not None
    assert new_generation.session_epoch == 2
    assert session.floor.state == "idle"
    assert session.playback_started(
        new_generation.utterance_id,
        new_generation.generation_epoch,
    )
    assert session.floor.utterance_id == new_generation.utterance_id
    assert session.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )
    assert session.floor.utterance_id == new_generation.utterance_id
    assert session.provider_turn_phase("old-response") is None


@pytest.mark.asyncio
async def test_guard_reconnect_old_clear_ack_cannot_remove_new_epoch_response_items() -> None:
    """An old renderer acknowledgement must settle bookkeeping in its completion epoch."""
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, deliveries=deliveries)
    await session.connect(tools=())
    old_item = HostContextItem.progress(
        host_item_id="old-host",
        event_id="old-event",
        content="old",
    )
    assert await session.deliver_host_item(old_item)
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="reused"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="reused", pcm=b"\x00\x01")
    )
    old_generation = session.current_generation
    assert old_generation is not None

    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    new_item = HostContextItem.progress(
        host_item_id="new-host",
        event_id="new-event",
        content="new",
    )
    assert await session.deliver_preemptive_host_response(HostResponseIntent.host_fact(new_item))
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="reused"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=2, response_id="reused", pcm=b"\x02\x03")
    )
    assert session.response_event_ids("reused") == ("new-event",)

    assert session.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )

    assert deliveries[-1].session_epoch == 1
    assert deliveries[-1].response_id == "reused"
    assert session.response_event_ids("reused") == ("new-event",)


@pytest.mark.asyncio
async def test_guard_handoff_alert_and_unknown_clear_retirement_are_exact_and_inert() -> None:
    """Deadline/ack uncertainty may retire only the captured old renderer identity."""
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, alerts=alerts, deliveries=deliveries)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old-response"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="old-response", pcm=b"\x00\x01")
    )
    old_generation = session.current_generation
    assert old_generation is not None
    assert session.playback_started(
        old_generation.utterance_id,
        old_generation.generation_epoch,
    )
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)

    assert session.alert_guard_handoff(old_generation)
    assert not session.alert_guard_handoff(old_generation)
    assert alerts == [(old_generation.utterance_id, old_generation.generation_epoch)]
    assert session.current_generation is None
    assert session.retire_playback_clear_unknown(old_generation)
    assert not session.retire_playback_clear_unknown(old_generation)
    assert deliveries == []
    assert session.floor.state == "idle"
    assert not session.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "reason"),
    [("completed", "completed"), ("cancelled", "client_cancelled")],
)
async def test_new_epoch_terminal_with_reused_response_id_never_fences_old_handoff(
    status: str,
    reason: str,
) -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="reused"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="reused", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="reused"))

    assert await session.accept(
        ResponseTerminal(
            session_epoch=2,
            response_id="reused",
            status=status,  # type: ignore[arg-type]
            reason=reason,
        )
    )

    assert session.current_generation == old_generation
    assert not [action for action in actions if action.startswith("clear:")]
    assert session.provider_turn_phase("reused") == status


@pytest.mark.asyncio
async def test_old_playback_stop_cannot_cancel_new_epoch_same_id_response() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="reused"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="reused", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="reused"))

    assert await session.playback_stopped(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )

    assert session.provider_turn_phase("reused") == "active"
    assert "cancel:reused" not in actions


@pytest.mark.asyncio
@pytest.mark.parametrize("preempt_kind", ["local", "host"])
async def test_cross_epoch_old_audio_preemption_cannot_cancel_same_id_new_guard(
    preempt_kind: str,
) -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="reused"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="reused", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="reused"))

    if preempt_kind == "local":
        await session.local_speech_onset("speech")
    else:
        assert not await session.host_preempt()

    assert session.provider_turn_phase("reused") == "active"
    assert "cancel:reused" not in actions


@pytest.mark.asyncio
async def test_naturally_done_old_handoff_is_consumed_by_new_first_frame_without_clear() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    frames: list[PlaybackFrame] = []
    session, _provider = make_session(actions, frames=frames, alerts=alerts)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="old",
            status="completed",
            reason="completed",
        )
    )
    old_generation = session.current_generation
    assert old_generation is not None
    assert session.playback_done(old_generation.utterance_id, old_generation.generation_epoch)
    assert session.current_generation is None

    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="guard"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=2, response_id="guard", pcm=b"\x02\x03")
    )

    assert not [action for action in actions if action.startswith("clear:")]
    assert alerts == []
    assert not session.alert_guard_handoff(old_generation)


@pytest.mark.asyncio
async def test_guard_reconnect_rejects_unknown_generation_after_natural_completion() -> None:
    session, _provider = make_session([])
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="old",
            status="completed",
            reason="completed",
        )
    )
    old_generation = session.current_generation
    assert old_generation is not None
    assert session.playback_done(old_generation.utterance_id, old_generation.generation_epoch)
    unknown = PlaybackGeneration(
        session_epoch=old_generation.session_epoch,
        generation_epoch=old_generation.generation_epoch,
        generation_id="unknown-generation",
        utterance_id=old_generation.utterance_id,
        response_id=old_generation.response_id,
    )

    with pytest.raises(ValueError, match="known playback generation"):
        await session.reconnect_for_guard(tools=(), old_generation=unknown)


@pytest.mark.asyncio
async def test_naturally_finished_old_handoff_deadline_emits_one_identityless_alert() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    session, _provider = make_session(actions, alerts=alerts)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    assert session.playback_done(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )

    assert session.alert_guard_handoff(old_generation)
    assert not session.alert_guard_handoff(old_generation)
    assert alerts == [(None, None)]


@pytest.mark.asyncio
async def test_cleared_old_handoff_is_consumed_by_same_id_new_first_frame() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="reused"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="reused", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    await session.reconnect_for_guard(tools=(), old_generation=old_generation)
    await session.local_speech_onset("speech")
    assert session.playback_cleared(
        old_generation.utterance_id,
        old_generation.generation_epoch,
        played_ms=100,
    )

    assert await session.accept(ResponseStarted(session_epoch=2, response_id="reused"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=2, response_id="reused", pcm=b"\x02\x03")
    )

    assert (
        actions.count(f"clear:{old_generation.utterance_id}:{old_generation.generation_epoch}") == 1
    )
    assert not session.alert_guard_handoff(old_generation)


@pytest.mark.asyncio
async def test_guard_reconnect_connect_failure_keeps_old_generation_alertable() -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    deliveries: list[PlaybackCompletion] = []
    session, provider = make_session(actions, alerts=alerts, deliveries=deliveries)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    provider.connect_failure = RuntimeError("connect failed")

    with pytest.raises(RuntimeError, match="connect failed"):
        await session.reconnect_for_guard(tools=(), old_generation=old_generation)

    assert session.alert_guard_handoff(old_generation)
    assert deliveries == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_type", [RuntimeError, asyncio.CancelledError])
async def test_guard_reconnect_recovery_failure_keeps_old_generation_alertable(
    failure_type: type[BaseException],
) -> None:
    actions: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    deliveries: list[PlaybackCompletion] = []
    session, provider = make_session(actions, alerts=alerts, deliveries=deliveries)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old"))
    await session.accept(ResponseAudioDelta(session_epoch=1, response_id="old", pcm=b"\x00\x01"))
    old_generation = session.current_generation
    assert old_generation is not None
    provider.injection_failure = failure_type("recovery failed")

    with pytest.raises(failure_type):
        await session.reconnect_for_guard(tools=(), old_generation=old_generation)

    assert session.alert_guard_handoff(old_generation)
    assert deliveries == []


@pytest.mark.asyncio
async def test_ordinary_reconnect_still_clears_current_generation_immediately() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(ResponseStarted(session_epoch=1, response_id="old-response"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="old-response", pcm=b"\x00\x01")
    )
    generation = session.current_generation
    assert generation is not None

    await session.reconnect(tools=())

    assert f"clear:{generation.utterance_id}:{generation.generation_epoch}" in actions


@pytest.mark.asyncio
async def test_reconnect_releases_only_unbound_host_response_dedupe() -> None:
    """Reconnect retries an unbound fact but retains dedupe once the retry is bound."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.progress(
        host_item_id="host-background",
        event_id="background:delegate-1",
        content="Codex is working.",
    )

    assert await session.deliver_host_item(item)
    await session.reconnect(tools=())

    assert await session.deliver_host_item(item)
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="response-2"))
    assert await session.accept(
        ResponseTerminal(
            session_epoch=2,
            response_id="response-2",
            status="completed",
            reason="completed",
        )
    )

    await session.reconnect(tools=())

    before = (len(provider.injected), len(provider.response_intents))
    assert not await session.deliver_host_item(item)
    assert (len(provider.injected), len(provider.response_intents)) == before


@pytest.mark.asyncio
async def test_started_suggestion_cancel_releases_retry_authority_before_terminal() -> None:
    """A locally fenced no-audio response must not await a provider terminal to retry."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.final(
        host_item_id="host-suggestion",
        event_id="suggestion:cup",
        content="桌面上出现水杯",
    )

    assert await session.deliver_host_item(item)
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    assert session.host_event_is_deduplicated(item.event_id)

    await session.local_speech_onset("barge-in")

    assert not session.host_event_is_deduplicated(item.event_id)
    assert actions[-1] == "cancel:response-1"
    assert not await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    assert await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="cancelled",
            reason="host_preempted",
        )
    )
    assert await session.deliver_host_item(item)
    assert provider.injected == [item]
    assert provider.response_intents == [
        HostResponseIntent.host_fact(item),
        HostResponseIntent.host_fact(item),
    ]


@pytest.mark.asyncio
async def test_reconnect_retries_started_suggestion_in_new_epoch_and_delivers() -> None:
    """Reconnect revokes old injection authority before a suggestion callback retries."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.final(
        host_item_id="host-suggestion",
        event_id="suggestion:cup",
        content="桌面上出现水杯",
    )

    assert await session.deliver_host_item(item)
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))

    await session.reconnect(tools=())

    assert not session.host_event_is_deduplicated(item.event_id)
    assert await session.deliver_host_item(item)
    assert [injected for injected in provider.injected if injected.event_id == item.event_id] == [
        item,
        item,
    ]
    assert await session.accept(ResponseStarted(session_epoch=2, response_id="response-2"))
    assert await session.accept(
        ResponseAudioDelta(session_epoch=2, response_id="response-2", pcm=b"\x00\x01")
    )
    assert await session.accept(
        ResponseTerminal(
            session_epoch=2,
            response_id="response-2",
            status="completed",
            reason="completed",
        )
    )
    generation = session.current_generation
    assert generation is not None
    assert session.playback_done(generation.utterance_id, generation.generation_epoch)
    assert session.response_event_ids("response-2") == ()


@pytest.mark.asyncio
async def test_reconnect_recovery_snapshot_is_bounded_for_many_active_delegates() -> None:
    """A controlled reconnect at tool capacity must still emit a valid recovery item."""
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    for index in range(500):
        session.register_delegate(
            f"delegate-{index}",
            summary=f"任务 {index} " + "x" * 220,
            state="running",
            progress_summary=f"进度 {index} " + "y" * 200,
            internal_activity=index + 1,
            elapsed=float(index),
        )

    await session.reconnect(tools=())

    recovery = provider.injected[-1]
    assert recovery.kind == "recovery"
    assert len(recovery.content) <= MAX_REALTIME_TEXT
    assert "active_work_count=500" in recovery.content
    assert "active_work_omitted=" in recovery.content


def test_register_delegate_merges_progress_slot_across_reregistration() -> None:
    """Handoff/dispatch re-registrations carry no progress kwargs and must not erase them."""
    session, _provider = make_session([])

    session.register_delegate(
        "delegate-1",
        summary="Build Tetris",
        state="running",
        progress_summary="已执行 3 条命令。正在实现方块旋转",
        internal_activity=3,
        elapsed=41.2,
    )
    session.register_delegate("delegate-1", summary="Build Tetris", state="running")

    record = dict(session.snapshot().active_delegates)["delegate-1"]
    assert record.progress_summary == "已执行 3 条命令。正在实现方块旋转"
    assert record.internal_activity == 3
    assert record.elapsed == 41.2


@pytest.mark.asyncio
async def test_recovery_frame_labels_delegate_channel() -> None:
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    session.register_delegate(
        "delegate-watch",
        summary="寻找水杯",
        state="running",
        channel="watch",
    )

    await session.reconnect(tools=())

    assert (
        "active_work_channel=watch;active_work=寻找水杯; state=running"
        in provider.injected[-1].content
    )


def test_register_delegate_clamps_progress_summary_defensively() -> None:
    session, _provider = make_session([])

    session.register_delegate(
        "delegate-1",
        summary="Build Tetris",
        state="running",
        progress_summary="x" * 500,
        internal_activity=1,
        elapsed=1.0,
    )

    record = dict(session.snapshot().active_delegates)["delegate-1"]
    assert record.progress_summary == "x" * 400


@pytest.mark.asyncio
async def test_recovery_frame_appends_bounded_progress_line() -> None:
    actions: list[str] = []
    session, provider = make_session(actions)
    await session.connect(tools=())
    progress_summary = "已执行 3 条命令。" + "旋" * 150
    session.register_delegate(
        "delegate-1",
        summary="Build Tetris",
        state="running",
        progress_summary=progress_summary,
        internal_activity=3,
        elapsed=41.2,
    )

    await session.reconnect(tools=())

    recovery = provider.injected[-1]
    assert recovery.kind == "recovery"
    assert f"; progress={progress_summary[:120]}" in recovery.content
    assert progress_summary not in recovery.content


@pytest.mark.asyncio
async def test_cancelled_provider_response_cannot_be_acknowledged_as_spoken() -> None:
    """Treating provider cancellation as synthesis completion would commit unheard speech."""
    actions: list[str] = []
    spoken: list[str] = []
    session, _provider = make_session(actions, spoken=spoken)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="Unheard text")
    )
    generation = session.current_generation
    assert generation is not None

    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="cancelled",
            reason="turn_detected",
        )
    )

    assert session.playback_done(generation.utterance_id, generation.generation_epoch) is False
    assert session.snapshot().interrupted_event_ids == ("event-progress",)
    assert spoken == []


@pytest.mark.asyncio
async def test_barge_in_cleared_ack_reports_interrupted_delivery_once() -> None:
    """The cleared acknowledgement is the only evidence of how much barge-in truncated."""
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, deliveries=deliveries)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="进度一")
    )
    assert session.playback_started("utterance-1", 1) is True
    assert session.playback_started("utterance-1", 1) is False

    await session.local_speech_onset("speech-user")

    assert session.playback_cleared("utterance-1", 1, played_ms=420) is True
    assert deliveries[-1].disposition == "interrupted"
    assert deliveries[-1].played_ms == 420
    assert deliveries[-1].text == "进度一"
    assert session.playback_cleared("utterance-1", 1, played_ms=420) is False
    assert (
        await session.accept(
            ResponseTranscriptFinal(
                session_epoch=1,
                response_id="response-1",
                text="进度一，以及用户没有听到的尾部",
            )
        )
        is False
    )
    assert len(deliveries) == 1


@pytest.mark.asyncio
async def test_renderer_stop_reports_interrupted_delivery_with_positional_evidence() -> None:
    """A renderer-initiated stop must record the audible portion, not silently discard it."""
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, deliveries=deliveries)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    session.playback_started("utterance-1", 1)

    assert await session.playback_stopped("utterance-1", 1, played_ms=100) is True

    assert actions[-1] == "cancel:response-1"
    assert deliveries[-1].disposition == "interrupted"
    assert deliveries[-1].played_ms == 100


@pytest.mark.asyncio
async def test_playback_done_reports_spoken_delivery_with_positional_evidence() -> None:
    actions: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(actions, deliveries=deliveries)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="说完了。")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )
    session.playback_started("utterance-1", 1)

    assert session.playback_done("utterance-1", 1, played_ms=900) is True

    assert deliveries == [
        PlaybackCompletion(
            session_epoch=1,
            response_id="response-1",
            utterance_id="utterance-1",
            generation_epoch=1,
            text="说完了。",
            disposition="spoken",
            started=True,
            played_ms=900,
        )
    ]


@pytest.mark.asyncio
async def test_user_transcript_final_is_accepted_once_per_provider_item() -> None:
    """Replayed provider transcripts must not become duplicate authoritative user input."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    first = await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="item-1", text="你好")
    )
    duplicate = await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="item-1", text="你好")
    )
    stale_epoch = await session.accept(
        UserTranscriptFinal(session_epoch=2, item_id="item-2", text="stale")
    )

    assert first is True
    assert duplicate is False
    assert stale_epoch is False


@pytest.mark.asyncio
async def test_matching_speech_and_late_transcript_increment_one_user_turn() -> None:
    """A provider item's speech and terminal transcript are one logical user turn."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserSpeechStarted(
            session_epoch=1,
            speech_id="speech-1",
            provider_item_id="user-1",
        )
    )
    assert session.user_input_revision == 1
    assert await session.accept(
        UserSpeechEnded(
            session_epoch=1,
            speech_id="speech-1",
            provider_item_id="user-1",
        )
    )
    assert await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="实现俄罗斯方块")
    )

    assert session.user_input_revision == 1


@pytest.mark.asyncio
async def test_speech_end_provider_item_aliases_fallback_user_turn() -> None:
    """A provider item learned at VAD end must not open a second logical turn."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(UserSpeechStarted(session_epoch=1, speech_id="speech-1"))
    assert session.user_input_revision == 1
    assert await session.accept(
        UserSpeechEnded(
            session_epoch=1,
            speech_id="speech-1",
            provider_item_id="user-1",
        )
    )
    assert await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="实现俄罗斯方块")
    )

    assert session.user_input_revision == 1


@pytest.mark.asyncio
async def test_reconnect_accepts_reused_provider_transcript_item_id() -> None:
    """Provider item IDs are session-scoped and may be reused after reconnect."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="第一轮")
    )
    assert session.user_input_revision == 1

    await session.reconnect(tools=())

    assert await session.accept(
        UserTranscriptFinal(session_epoch=2, item_id="user-1", text="第二轮")
    )
    assert session.user_input_revision == 2


@pytest.mark.asyncio
async def test_transcript_only_item_opens_one_user_turn() -> None:
    """A terminal transcript without VAD begins one, non-replayable user turn."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="实现俄罗斯方块")
    )
    assert session.user_input_revision == 1
    assert not await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="user-1", text="重复事件")
    )
    assert session.user_input_revision == 1


@pytest.mark.asyncio
async def test_new_provider_item_opens_second_user_turn_before_transcript() -> None:
    """Each new provider item advances the revision at VAD onset, not terminal ASR."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-1", provider_item_id="user-1")
    )
    assert session.user_input_revision == 1
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-1", provider_item_id="user-1")
    )
    assert await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-2", provider_item_id="user-2")
    )

    assert session.user_input_revision == 2


@pytest.mark.asyncio
async def test_user_transcript_failure_is_terminal_without_awaiting_response() -> None:
    """An ASR failure consumes its item ID without making it a user-response trigger."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    failed = await session.accept(UserTranscriptFailed(session_epoch=1, item_id="item-1"))
    duplicate_final = await session.accept(
        UserTranscriptFinal(session_epoch=1, item_id="item-1", text="fabricated")
    )

    assert failed is True
    assert duplicate_final is False
    assert session._awaiting_user_response is False


@pytest.mark.asyncio
async def test_floor_tracks_audible_assistant_interval() -> None:
    """Floor must reflect actual audibility: granted at playback start, released at done."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )
    assert session.floor.state == "idle"

    session.playback_started("utterance-1", 1)
    assert session.floor.state == "agent_speaking"
    assert session.floor.utterance_id == "utterance-1"

    session.playback_done("utterance-1", 1)
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_response_started_during_user_floor_is_fenced_for_its_entire_lifetime() -> None:
    """A response born under user Floor must not reopen later with only its suffix audible."""
    actions: list[str] = []
    frames: list[PlaybackFrame] = []
    spoken: list[str] = []
    deliveries: list[PlaybackCompletion] = []
    session, _provider = make_session(
        actions,
        frames=frames,
        spoken=spoken,
        deliveries=deliveries,
    )
    await session.connect(tools=())
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    assert session.floor.state == "user_speaking"

    accepted = await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))

    assert accepted is False
    assert actions.count("cancel:response-1") == 1
    assert (
        await session.accept(
            ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
        )
        is False
    )
    assert (
        await session.accept(
            ResponseTranscriptFinal(
                session_epoch=1,
                response_id="response-1",
                text="完整但用户没听到的回答",
            )
        )
        is False
    )
    await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    assert (
        await session.accept(
            ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x02\x03")
        )
        is False
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )

    assert frames == []
    assert session.current_generation is None
    assert spoken == []
    assert deliveries == []


@pytest.mark.asyncio
async def test_playback_start_ack_cannot_steal_user_floor() -> None:
    """A start acknowledgement racing barge-in records evidence but never takes the floor."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    await session.local_speech_onset("speech-user")

    session.playback_started("utterance-1", 1)

    assert session.floor.state == "user_speaking"


@pytest.mark.asyncio
async def test_stale_user_hold_is_released_only_after_threshold() -> None:
    """A lost provider speech-end must not starve host delivery forever."""
    actions: list[str] = []
    clock = VirtualClock()
    session, _provider = make_session(actions, clock=clock)
    await session.connect(tools=())
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )

    clock.advance_to(29.0)
    assert session.release_stale_user_hold(30.0) is False
    assert session.floor.state == "user_speaking"

    clock.advance_to(30.5)
    assert session.release_stale_user_hold(30.0) is True
    assert session.floor.state == "idle"
    assert session.release_stale_user_hold(30.0) is False


@pytest.mark.asyncio
async def test_reconnect_resets_floor() -> None:
    """A reconnect during user speech must not inherit an orphaned floor hold."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    assert session.floor.state == "user_speaking"

    await session.reconnect(tools=())

    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_captions_accumulate_deltas_and_reset_on_final() -> None:
    """The speculative caption is a revisable tail view, never session or Memory state."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))

    first = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="你好")
    )
    second = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="，世界")
    )
    final = session.caption_for(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="你好，世界。")
    )

    assert first == CaptionFrame(role="assistant", text="你好", final=False)
    assert second == CaptionFrame(role="assistant", text="你好，世界", final=False)
    assert final == CaptionFrame(role="assistant", text="你好，世界。", final=True)

    user = session.caption_for(UserTranscriptFinal(session_epoch=1, item_id="item-1", text="继续"))
    assert user == CaptionFrame(role="user", text="继续", final=True)


@pytest.mark.asyncio
async def test_captions_refuse_fenced_responses_stale_epochs_and_truncate_tails() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    await session.local_speech_onset("speech-user")

    fenced = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="被拦下")
    )
    stale = session.caption_for(
        UserTranscriptDelta(session_epoch=2, item_id="item-1", text="stale")
    )
    await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="item-user")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="cancelled",
            reason="barge_in",
        )
    )
    session.playback_cleared("utterance-1", 1, 0)
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress-2",
            event_id="event-progress-2",
            content="Codex is still working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-2"))
    long_tail = session.caption_for(
        ResponseTranscriptDelta(
            session_epoch=1,
            response_id="response-2",
            text="长" * (MAX_CAPTION_CHARS + 20),
        )
    )

    assert fenced is None
    assert stale is None
    assert long_tail is not None
    assert len(long_tail.text) == MAX_CAPTION_CHARS


@pytest.mark.asyncio
async def test_same_host_event_cannot_create_a_second_response_intent() -> None:
    """Missing host event deduplication would replay progress after reconnect or retry."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    item = HostContextItem.progress(
        host_item_id="host-progress",
        event_id="event-progress",
        content="Codex is working.",
    )

    assert await session.deliver_host_item(item) is True
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.local_speech_onset("speech-user")
    before = list(actions)

    assert await session.deliver_host_item(item) is False
    assert actions == before


@pytest.mark.asyncio
async def test_host_delivery_waits_for_the_fence_delivery_report() -> None:
    """UserSpeechEnded racing the renderer cleared ack must not reopen the foreground."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    generation = session.current_generation
    assert generation is not None

    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-user", provider_item_id="item-1")
    )
    await session.local_speech_onset("speech-user")
    await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-user", provider_item_id="item-1")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="cancelled",
            reason="barge_in",
        )
    )

    assert session.floor.state == "idle"
    assert session.foreground_idle is False  # cleared ack not yet arrived

    session.playback_cleared(generation.utterance_id, generation.generation_epoch, 0)

    assert session.foreground_idle is True


@pytest.mark.asyncio
async def test_local_onset_does_not_extend_the_provider_user_hold() -> None:
    """Local onset is secondary and cannot renew provider-owned floor authority."""
    actions: list[str] = []
    clock = VirtualClock()
    session, _provider = make_session(actions, clock=clock)
    await session.connect(tools=())

    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-long", provider_item_id="item-long")
    )
    clock.advance_to(20.0)
    await session.local_speech_onset("speech-long")
    clock.advance_to(35.0)

    assert session.release_stale_user_hold(30.0) is True
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_caption_refuses_deltas_from_a_response_the_session_never_accepted() -> None:
    """A refused response must not put unauthorized speculative text on screen."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-a"))
    refused = await session.accept(ResponseStarted(session_epoch=1, response_id="response-b"))
    assert refused is False

    caption = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-b", text="未授权文本")
    )

    assert caption is None
    allowed = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-a", text="正常文本")
    )
    assert allowed is not None


@pytest.mark.asyncio
async def test_caption_final_requires_session_acceptance() -> None:
    """A duplicate user transcript final must not re-caption after dedupe rejected it."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    final = UserTranscriptFinal(session_epoch=1, item_id="item-1", text="你好")

    assert await session.accept(final) is True
    assert session.caption_for(final, accepted=True) is not None
    assert await session.accept(final) is False
    assert session.caption_for(final, accepted=False) is None


@pytest.mark.asyncio
async def test_reconnect_resets_caption_accumulators() -> None:
    """Dead-epoch speculative text must not leak into the next epoch's captions."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    assert await session.accept(ResponseStarted(session_epoch=1, response_id="response-a"))
    session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-a", text="旧纪元文本")
    )

    await session.reconnect(tools=())
    session.reset_captions()

    assert await session.accept(ResponseStarted(session_epoch=2, response_id="response-a"))
    caption = session.caption_for(
        ResponseTranscriptDelta(session_epoch=2, response_id="response-a", text="新")
    )
    assert caption is not None
    assert caption.text == "新"


@pytest.mark.asyncio
async def test_provider_turn_memory_is_bounded() -> None:
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())

    for index in range(600):
        await session.accept(ResponseStarted(session_epoch=1, response_id=f"response-{index}"))
        await session.local_speech_onset(f"speech-{index}")
        await session.accept(
            ResponseTerminal(
                session_epoch=1,
                response_id=f"response-{index}",
                status="cancelled",
                reason="test",
            )
        )

    assert len(session._provider_turns) <= 500


@pytest.mark.asyncio
async def test_local_onset_refresh_does_not_steal_the_provider_speech_identity() -> None:
    """A periodic renderer re-onset must not break provider speech-end matching."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.accept(
        UserSpeechStarted(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )

    await session.local_speech_onset("speech-local-refresh")

    assert session.floor.user_speech_id == "speech-provider"
    assert await session.accept(
        UserSpeechEnded(session_epoch=1, speech_id="speech-provider", provider_item_id="item-1")
    )
    assert session.floor.state == "idle"


@pytest.mark.asyncio
async def test_transcript_dedupe_window_outlives_the_old_64_cap() -> None:
    """A replayed early transcript must stay rejected far beyond provider history."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    first = UserTranscriptFinal(session_epoch=1, item_id="item-0", text="第一句")
    assert await session.accept(first) is True

    for index in range(1, 201):
        accepted = await session.accept(
            UserTranscriptFinal(session_epoch=1, item_id=f"item-{index}", text="后续")
        )
        assert accepted is True

    assert await session.accept(first) is False


@pytest.mark.asyncio
async def test_caption_authority_ends_with_the_delivery_report() -> None:
    """A delivered response must not keep captioning late transcript deltas."""
    actions: list[str] = []
    session, _provider = make_session(actions)
    await session.connect(tools=())
    await session.deliver_host_item(
        HostContextItem.progress(
            host_item_id="host-progress",
            event_id="event-progress",
            content="Codex is working.",
        )
    )
    await session.accept(ResponseStarted(session_epoch=1, response_id="response-1"))
    await session.accept(
        ResponseAudioDelta(session_epoch=1, response_id="response-1", pcm=b"\x00\x01")
    )
    await session.accept(
        ResponseTranscriptFinal(session_epoch=1, response_id="response-1", text="完成")
    )
    await session.accept(
        ResponseTerminal(
            session_epoch=1,
            response_id="response-1",
            status="completed",
            reason="completed",
        )
    )
    generation = session.current_generation
    assert generation is not None
    assert session.playback_done(generation.utterance_id, generation.generation_epoch)

    late = session.caption_for(
        ResponseTranscriptDelta(session_epoch=1, response_id="response-1", text="迟到文本")
    )

    assert late is None
