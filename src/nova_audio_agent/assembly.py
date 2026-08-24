"""Production assembly: the only layer that reads model configuration."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal
from uuid import uuid4

from openai import AsyncOpenAI

from nova_audio_agent.calls import AttentionDecision
from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import ConfigurationError, Settings, resolve_proactivity
from nova_audio_agent.executors.autoglm import AutoGlmAdapter, AutoGlmWdaClient
from nova_audio_agent.executors.autoglm_transport import AutoGlmTransport
from nova_audio_agent.executors.camera import (
    CamAdapter,
    DisabledFrameSource,
    FrameSource,
    OpenCVFrameSource,
    VideoFileFrameSource,
)
from nova_audio_agent.executors.codex import CodexAdapter
from nova_audio_agent.executors.codex_app_server import CodexAppServerTransport
from nova_audio_agent.executors.codex_live import CodexLiveAdapter
from nova_audio_agent.executors.codex_project_live import ProjectCodexAdapter
from nova_audio_agent.executors.codex_projects import (
    CodexProjectStore,
    ProjectStateError,
    PublicProjectView,
)
from nova_audio_agent.executors.codex_transport import CodexTransport
from nova_audio_agent.executors.home_assistant import (
    HomeAssistantAdapter,
    HomeAssistantTransport,
)
from nova_audio_agent.executors.search import SearchAdapter, TavilyTransport
from nova_audio_agent.executors.sims import FastSim, SlowSim
from nova_audio_agent.executors.watcher import GUARD_MANIFEST, WATCH_MANIFEST, WatchAdapter
from nova_audio_agent.events import WakeReason
from nova_audio_agent.memory import Memory
from nova_audio_agent.media import MediaStore
from nova_audio_agent.model_adapters import GatewayCompressor, GatewayFastBrain, GatewaySurrogate
from nova_audio_agent.model_gateway import MetricsSink, OpenAIModelGateway
from nova_audio_agent.ports import ExecutorAdapter
from nova_audio_agent.prompting import FASTBRAIN_LIVE_SYSTEM
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.realtime.project_confirmation import ProjectConfirmationController
from nova_audio_agent.realtime.protocol import HostContextItem, SessionIdentity
from nova_audio_agent.realtime.qwen import render_active_project_context
from nova_audio_agent.speech import SpeechSink
from nova_audio_agent.suggestions import Suggestion
from nova_audio_agent.tool_schema import CompiledTools, compile_tool_schema
from nova_audio_agent.trace import TraceWriter

if TYPE_CHECKING:
    from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame
    from nova_audio_agent.realtime.protocol import RealtimeFrontBrain
    from nova_audio_agent.realtime.service import CodexState, RealtimeService
    from nova_audio_agent.realtime.session import CaptionFrame
    from nova_audio_agent.realtime.telemetry import RealtimeTelemetry

CameraSourceName = Literal["auto", "local", "disabled", "file"]
ResolvedCameraSource = Literal["local", "disabled", "file"]
_AUTOGLM_RUNNER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "autoglm_ios_runner.py"


def _active_executor_names(
    settings: Settings,
) -> tuple[tuple[str, ...], frozenset[str] | None]:
    raw = settings.executors
    if not raw:
        return (settings.executor,), None
    names = tuple(part.strip() for part in raw.split(","))
    if any(not name for name in names):
        raise ConfigurationError("NOVA_AUDIO_AGENT_EXECUTORS 不能包含空名称")
    if len(set(names)) != len(names):
        raise ConfigurationError("NOVA_AUDIO_AGENT_EXECUTORS 不能包含重复名称")
    unknown = set(names) - _EXECUTOR_FACTORIES.keys()
    if unknown:
        raise ConfigurationError(f"NOVA_AUDIO_AGENT_EXECUTORS 包含未知执行器：{sorted(unknown)[0]}")
    return names, frozenset(names)


def resolve_camera_source(
    *,
    active_executors: frozenset[str],
    requested: str,
    legacy_camera: bool,
    camera_index: int,
    camera_file: Path | None = None,
) -> ResolvedCameraSource:
    if requested not in {"auto", "local", "disabled", "file"}:
        raise ConfigurationError("--camera-source 必须是 auto、local、disabled 或 file")
    if legacy_camera and requested != "auto":
        raise ConfigurationError("--camera 与显式 --camera-source 冲突")
    if requested == "auto":
        resolved: ResolvedCameraSource = "local" if legacy_camera else "disabled"
    else:
        resolved = requested  # type: ignore[assignment]
    if camera_index != 0 and resolved != "local":
        raise ConfigurationError("--camera-index 只能用于 local 摄像头")
    if resolved == "file":
        if camera_file is None:
            raise ConfigurationError("--camera-source file 需要 --camera-file")
        if not camera_file.is_absolute():
            raise ConfigurationError("--camera-file 必须是绝对路径")
        if not camera_file.is_file():
            raise ConfigurationError("--camera-file 必须是已存在的普通文件")
    elif camera_file is not None:
        raise ConfigurationError("--camera-file 只能用于 file 摄像头")
    return resolved


@dataclass(slots=True)
class Assembly:
    runtime: Runtime
    gateway: OpenAIModelGateway
    tools: CompiledTools
    media_store: MediaStore
    frame_source: FrameSource
    _started: bool = False

    async def start(self) -> None:
        if self._started:
            return
        await self.frame_source.start()
        self._started = True

    async def stop(self) -> None:
        if not self._started:
            return
        await self.frame_source.stop()
        self._started = False


@dataclass(slots=True)
class RealtimeAssembly:
    core: Assembly
    provider: RealtimeFrontBrain
    service: RealtimeService
    codex_live_adapter: CodexLiveAdapter | None = None
    codex_prewarm: bool = True
    project_adapter: ProjectCodexAdapter | None = None
    project_context_publisher: _ProjectContextPublisher | None = None
    unsubscribe_project_context: Callable[[], None] | None = None
    _prewarm_task: asyncio.Task[None] | None = None

    @property
    def runtime(self) -> Runtime:
        return self.core.runtime

    @property
    def tools(self) -> CompiledTools:
        return self.core.tools

    async def start(self) -> None:
        if self.project_context_publisher is not None:
            if not callable(getattr(self.provider, "inject_workspace_context", None)):
                raise ConfigurationError(
                    "selected realtime provider cannot deliver active project context"
                )
            assert self.project_adapter is not None
            self.project_context_publisher.update(
                *self.project_adapter.public_project_context(
                    pending_confirmation=self.project_adapter.confirmation.pending
                )
            )
        await self.core.start()
        try:
            await self.service.start()
        except BaseException:
            await self.core.stop()
            raise
        if self.codex_prewarm and self.codex_live_adapter is not None:
            # Non-blocking (R102): session startup must not wait on the <=20s
            # Codex preflight; the first delegation joins the in-flight warmup.
            self._prewarm_task = asyncio.create_task(self.codex_live_adapter.prewarm())

    async def stop(self) -> None:
        prewarm_task, self._prewarm_task = self._prewarm_task, None
        if prewarm_task is not None and not prewarm_task.done():
            prewarm_task.cancel()
        try:
            if prewarm_task is not None:
                await asyncio.gather(prewarm_task, return_exceptions=True)
            await self.service.close()
        finally:
            try:
                await self.core.stop()
            finally:
                if self.unsubscribe_project_context is not None:
                    self.unsubscribe_project_context()
                    self.unsubscribe_project_context = None
                if self.codex_live_adapter is not None:
                    await self.codex_live_adapter.aclose()


class _ProjectContextPublisher:
    def __init__(
        self,
        *,
        provider: RealtimeFrontBrain,
        id_factory: Callable[[], str],
    ) -> None:
        self._provider = provider
        self._id_factory = id_factory
        self._context: tuple[str | None, PublicProjectView] | None = None
        self._epoch = 0
        self._revision = 0
        self._last_key: tuple[int, str, str] | None = None
        self._ownership_uncertain = False
        self._lock = asyncio.Lock()

    def update(self, workspace_id: str | None, view: PublicProjectView) -> None:
        self._context = (workspace_id, view)

    async def update_and_publish(self, workspace_id: str | None, view: PublicProjectView) -> None:
        self.update(workspace_id, view)
        await self._publish()

    async def connected(self, identity: SessionIdentity) -> None:
        self._epoch = identity.epoch
        self._last_key = None
        await self._publish()

    async def _publish(self) -> None:
        async with self._lock:
            context = self._context
            if context is None or context[0] is None or self._epoch < 1:
                return
            workspace_id, view = context
            assert workspace_id is not None
            content = render_active_project_context(view.workspace_display_name, view.session_title)
            key = (self._epoch, workspace_id, content)
            if not self._ownership_uncertain and key == self._last_key:
                return
            self._revision += 1
            item = HostContextItem.workspace_context(
                host_item_id=self._id_factory(),
                event_id=self._id_factory(),
                content=content,
                session_epoch=self._epoch,
                workspace_instance_id=workspace_id,
                revision=self._revision,
            )
            try:
                record = await self._provider.inject_workspace_context(item)  # type: ignore[attr-defined]
                if (
                    record.item != item
                    or record.delivery.delivered is not True
                    or record.delivery.session_epoch != self._epoch
                    or record.delivery.workspace_instance_id != workspace_id
                    or record.delivery.revision != self._revision
                ):
                    raise ValueError("workspace context delivery identity mismatch")
            except BaseException:
                self._ownership_uncertain = True
                self._last_key = None
                raise
            self._last_key = key
            self._ownership_uncertain = False


# Compatibility for callers that imported the original provider-specific name.
QwenRealtimeAssembly = RealtimeAssembly


def build_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    camera_source: CameraSourceName = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
    camera_file: Path | None = None,
    trace: TraceWriter | None = None,
    metrics: MetricsSink | None = None,
) -> Assembly:
    return _build_assembly(
        settings,
        sink=sink,
        camera_source=camera_source,
        camera_enabled=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
        trace=trace,
        metrics=metrics,
        codex_live=False,
        on_suggestion_selected=None,
        on_attention_decision=None,
    )


def build_codex_live_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    camera_source: CameraSourceName = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
    camera_file: Path | None = None,
    trace: TraceWriter | None = None,
    metrics: MetricsSink | None = None,
) -> Assembly:
    """Build the explicit opt-in app-server backend; the default factory stays D3."""
    active_names, _ = _active_executor_names(settings)
    if "codex" not in active_names:
        raise ConfigurationError("Codex live assembly 需要启用 codex executor")
    return _build_assembly(
        settings,
        sink=sink,
        camera_source=camera_source,
        camera_enabled=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
        trace=trace,
        metrics=metrics,
        codex_live=True,
        on_suggestion_selected=None,
        on_attention_decision=None,
    )


def build_qwen_realtime_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    on_audio_frame: Callable[[PlaybackFrame], None],
    on_audio_clear: Callable[[str, int], None],
    on_audio_terminal: Callable[[str, int], None],
    on_delivery: Callable[[PlaybackCompletion], None],
    on_audio_alert: Callable[[str | None, int | None], None] | None = None,
    on_codex_state: Callable[[CodexState], None] | None = None,
    on_spoken: Callable[[str], None] | None = None,
    on_caption: Callable[[CaptionFrame], None] | None = None,
    on_codex_project: Callable[[PublicProjectView], None] | None = None,
    realtime_telemetry: RealtimeTelemetry | None = None,
    id_factory: Callable[[], str] | None = None,
    camera_source: CameraSourceName = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
    camera_file: Path | None = None,
    trace: TraceWriter | None = None,
    metrics: MetricsSink | None = None,
    provider_tool_view: Callable[[CompiledTools], CompiledTools] | None = None,
) -> RealtimeAssembly:
    """Build the Qwen-first frontend with the configured active executors."""
    from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
    from nova_audio_agent.realtime.playback import PlaybackRegistry
    from nova_audio_agent.realtime.qwen import QwenAudioRealtimeAdapter
    from nova_audio_agent.realtime.service import RealtimeService
    from nova_audio_agent.realtime.session import RealtimeSession

    _active_executor_names(settings)
    url, model, voice, realtime_api_key = settings.require_qwen_realtime()
    configured_model_key = (
        settings.model_api_key.get_secret_value().strip()
        if settings.model_api_key is not None
        else ""
    )
    suggestion_outlet: Callable[[Suggestion, WakeReason], None] | None = None
    attention_outlet: Callable[[AttentionDecision], None] | None = None

    def relay_suggestion(suggestion: Suggestion, reason: WakeReason) -> None:
        if suggestion_outlet is not None:
            suggestion_outlet(suggestion, reason)

    def relay_attention(decision: AttentionDecision) -> None:
        if attention_outlet is not None:
            attention_outlet(decision)

    def relay_project(view: PublicProjectView) -> None:
        if on_codex_project is not None:
            on_codex_project(view)

    core = _build_assembly(
        settings,
        sink=sink,
        camera_source=camera_source,
        camera_enabled=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
        trace=trace,
        metrics=metrics,
        codex_live=True,
        realtime_frontbrain=True,
        model_api_key_override=configured_model_key or realtime_api_key,
        on_suggestion_selected=relay_suggestion,
        on_attention_decision=relay_attention,
        on_codex_project=relay_project,
    )
    provider_tools = core.tools if provider_tool_view is None else provider_tool_view(core.tools)
    _validate_provider_tool_view(core.tools, provider_tools)
    provider = QwenAudioRealtimeAdapter(
        url=url,
        api_key=realtime_api_key,
        model=model,
        voice=voice,
    )
    next_id = (lambda: f"nova_{uuid4().hex}") if id_factory is None else id_factory
    live_adapter = core.runtime.executors.get("codex")
    project_adapter = live_adapter if isinstance(live_adapter, ProjectCodexAdapter) else None
    project_context_publisher = (
        None
        if project_adapter is None
        else _ProjectContextPublisher(provider=provider, id_factory=next_id)
    )
    if project_context_publisher is None or project_adapter is None:
        unsubscribe_project_context = None
    else:

        async def publish_project_context(
            workspace_id: str | None,
            view: PublicProjectView,
        ) -> None:
            await project_context_publisher.update_and_publish(workspace_id, view)

        unsubscribe_project_context = project_adapter.observe_project_context(
            publish_project_context
        )
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=on_audio_frame,
        on_clear=on_audio_clear,
        on_alert=on_audio_alert,
    )
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_spoken=on_spoken,
        on_delivery=on_delivery,
        on_provider_connected=(
            None if project_context_publisher is None else project_context_publisher.connected
        ),
        clock=core.runtime.clock,
    )
    bridge = RealtimeRuntimeBridge(
        runtime=core.runtime,
        tools=core.tools,
        id_factory=next_id,
    )
    service = RealtimeService(
        provider=provider,
        runtime=core.runtime,
        tools=core.tools,
        provider_schemas=provider_tools.schemas,
        session=session,
        bridge=bridge,
        id_factory=next_id,
        on_provider_terminal=lambda generation: on_audio_terminal(
            generation.utterance_id,
            generation.generation_epoch,
        ),
        on_codex_state=on_codex_state,
        on_caption=on_caption,
        telemetry=realtime_telemetry,
        controlled_guard_reconnect=settings.qwen_controlled_guard_reconnect,
        guard_history_recovery=settings.qwen_guard_history_recovery,
        guard_history_pairs=settings.qwen_guard_history_pairs,
        project_confirmation=(None if project_adapter is None else project_adapter.confirmation),
        commit_project_operation=(
            (
                lambda operation, origin_ref: project_adapter.commit_confirmed(
                    operation,
                    origin_ref=origin_ref,
                    runtime_dispatch=core.runtime.dispatch_external,
                )
            )
            if project_adapter is not None
            else None
        ),
        on_project_view=(
            (
                lambda view: relay_project(
                    project_adapter.public_project_view(
                        pending_confirmation=view.pending_confirmation
                    )
                )
            )
            if project_adapter is not None
            else None
        ),
    )
    suggestion_outlet = service.on_suggestion_selected
    attention_outlet = service.on_attention_decision
    return RealtimeAssembly(
        core=core,
        provider=provider,
        service=service,
        codex_live_adapter=(live_adapter if isinstance(live_adapter, CodexLiveAdapter) else None),
        codex_prewarm=settings.codex_prewarm and not isinstance(live_adapter, ProjectCodexAdapter),
        project_adapter=project_adapter,
        project_context_publisher=project_context_publisher,
        unsubscribe_project_context=unsubscribe_project_context,
    )


def build_volcengine_realtime_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    on_audio_frame: Callable[[PlaybackFrame], None],
    on_audio_clear: Callable[[str, int], None],
    on_audio_terminal: Callable[[str, int], None],
    on_delivery: Callable[[PlaybackCompletion], None],
    on_audio_alert: Callable[[str | None, int | None], None] | None = None,
    on_codex_state: Callable[[CodexState], None] | None = None,
    on_spoken: Callable[[str], None] | None = None,
    on_caption: Callable[[CaptionFrame], None] | None = None,
    on_codex_project: Callable[[PublicProjectView], None] | None = None,
    realtime_telemetry: RealtimeTelemetry | None = None,
    id_factory: Callable[[], str] | None = None,
    camera_source: CameraSourceName = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
    camera_file: Path | None = None,
    trace: TraceWriter | None = None,
    metrics: MetricsSink | None = None,
    provider_tool_view: Callable[[CompiledTools], CompiledTools] | None = None,
) -> RealtimeAssembly:
    """Build the native Volcengine VAD → ASR → Ark → TTS frontend."""
    from nova_audio_agent.realtime.bridge import RealtimeRuntimeBridge
    from nova_audio_agent.realtime.playback import PlaybackRegistry
    from nova_audio_agent.realtime.qwen import FRONTEND_INSTRUCTIONS
    from nova_audio_agent.realtime.service import RealtimeService
    from nova_audio_agent.realtime.session import RealtimeSession
    from nova_audio_agent.realtime.volcengine import (
        ArkResponsesClient,
        DoubaoAsrClient,
        DoubaoTtsClient,
        SileroVadConfig,
        SileroVadSegmenter,
        VolcengineCascadedAdapter,
    )

    _active_executor_names(settings)
    config = settings.require_volcengine_realtime()
    configured_model_key = (
        settings.model_api_key.get_secret_value().strip()
        if settings.model_api_key is not None
        else ""
    )
    suggestion_outlet: Callable[[Suggestion, WakeReason], None] | None = None
    attention_outlet: Callable[[AttentionDecision], None] | None = None

    def relay_suggestion(suggestion: Suggestion, reason: WakeReason) -> None:
        if suggestion_outlet is not None:
            suggestion_outlet(suggestion, reason)

    def relay_attention(decision: AttentionDecision) -> None:
        if attention_outlet is not None:
            attention_outlet(decision)

    def relay_project(view: PublicProjectView) -> None:
        if on_codex_project is not None:
            on_codex_project(view)

    core = _build_assembly(
        settings,
        sink=sink,
        camera_source=camera_source,
        camera_enabled=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
        trace=trace,
        metrics=metrics,
        codex_live=True,
        realtime_frontbrain=True,
        model_api_key_override=configured_model_key or config.ark_api_key,
        model_base_url_override=(None if configured_model_key else config.ark_base_url),
        support_model_override=(None if configured_model_key else config.ark_support_model),
        on_suggestion_selected=relay_suggestion,
        on_attention_decision=relay_attention,
        on_codex_project=relay_project,
    )
    provider_tools = core.tools if provider_tool_view is None else provider_tool_view(core.tools)
    _validate_provider_tool_view(core.tools, provider_tools)
    next_id = (lambda: f"nova_{uuid4().hex}") if id_factory is None else id_factory
    provider = VolcengineCascadedAdapter(
        vad=SileroVadSegmenter(
            SileroVadConfig(
                threshold=config.vad_threshold,
                pre_roll_ms=config.vad_pre_roll_ms,
                min_speech_ms=config.vad_min_speech_ms,
                silence_end_ms=config.vad_silence_end_ms,
                speech_pad_ms=config.vad_speech_pad_ms,
                max_utterance_ms=config.vad_max_utterance_ms,
            )
        ),
        asr=DoubaoAsrClient(
            endpoint=config.asr_endpoint,
            api_key=config.asr_api_key,
            resource_id=config.asr_resource_id,
            chunk_ms=config.asr_chunk_ms,
        ),
        ark=ArkResponsesClient(
            client=AsyncOpenAI(
                api_key=config.ark_api_key,
                base_url=config.ark_base_url,
                timeout=30.0,
            ),
            model=config.ark_model,
            instructions=FRONTEND_INSTRUCTIONS,
        ),
        tts=DoubaoTtsClient(
            endpoint=config.tts_endpoint,
            api_key=config.tts_api_key,
            resource_id=config.tts_resource_id,
            voice=config.tts_voice,
            output_sample_rate=config.tts_output_sample_rate,
            id_factory=next_id,
        ),
        telemetry=realtime_telemetry,
        id_factory=next_id,
    )
    live_adapter = core.runtime.executors.get("codex")
    project_adapter = live_adapter if isinstance(live_adapter, ProjectCodexAdapter) else None
    project_context_publisher = (
        None
        if project_adapter is None
        else _ProjectContextPublisher(provider=provider, id_factory=next_id)
    )
    if project_context_publisher is None or project_adapter is None:
        unsubscribe_project_context = None
    else:

        async def publish_project_context(
            workspace_id: str | None,
            view: PublicProjectView,
        ) -> None:
            await project_context_publisher.update_and_publish(workspace_id, view)

        unsubscribe_project_context = project_adapter.observe_project_context(
            publish_project_context
        )
    playback = PlaybackRegistry(
        id_factory=next_id,
        on_frame=on_audio_frame,
        on_clear=on_audio_clear,
        on_alert=on_audio_alert,
    )
    session = RealtimeSession(
        provider=provider,
        playback=playback,
        id_factory=next_id,
        on_spoken=on_spoken,
        on_delivery=on_delivery,
        on_provider_connected=(
            None if project_context_publisher is None else project_context_publisher.connected
        ),
        clock=core.runtime.clock,
    )
    bridge = RealtimeRuntimeBridge(
        runtime=core.runtime,
        tools=core.tools,
        id_factory=next_id,
    )
    service = RealtimeService(
        provider=provider,
        runtime=core.runtime,
        tools=core.tools,
        provider_schemas=provider_tools.schemas,
        session=session,
        bridge=bridge,
        id_factory=next_id,
        on_provider_terminal=lambda generation: on_audio_terminal(
            generation.utterance_id,
            generation.generation_epoch,
        ),
        on_codex_state=on_codex_state,
        on_caption=on_caption,
        telemetry=realtime_telemetry,
        controlled_guard_reconnect=False,
        guard_history_recovery="none",
        guard_history_pairs=settings.qwen_guard_history_pairs,
        project_confirmation=(None if project_adapter is None else project_adapter.confirmation),
        commit_project_operation=(
            (
                lambda operation, origin_ref: project_adapter.commit_confirmed(
                    operation,
                    origin_ref=origin_ref,
                    runtime_dispatch=core.runtime.dispatch_external,
                )
            )
            if project_adapter is not None
            else None
        ),
        on_project_view=(
            (
                lambda view: relay_project(
                    project_adapter.public_project_view(
                        pending_confirmation=view.pending_confirmation
                    )
                )
            )
            if project_adapter is not None
            else None
        ),
    )
    suggestion_outlet = service.on_suggestion_selected
    attention_outlet = service.on_attention_decision
    return RealtimeAssembly(
        core=core,
        provider=provider,
        service=service,
        codex_live_adapter=(live_adapter if isinstance(live_adapter, CodexLiveAdapter) else None),
        codex_prewarm=settings.codex_prewarm and not isinstance(live_adapter, ProjectCodexAdapter),
        project_adapter=project_adapter,
        project_context_publisher=project_context_publisher,
        unsubscribe_project_context=unsubscribe_project_context,
    )


def build_realtime_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    on_audio_frame: Callable[[PlaybackFrame], None],
    on_audio_clear: Callable[[str, int], None],
    on_audio_terminal: Callable[[str, int], None],
    on_delivery: Callable[[PlaybackCompletion], None],
    on_audio_alert: Callable[[str | None, int | None], None] | None = None,
    on_codex_state: Callable[[CodexState], None] | None = None,
    on_spoken: Callable[[str], None] | None = None,
    on_caption: Callable[[CaptionFrame], None] | None = None,
    on_codex_project: Callable[[PublicProjectView], None] | None = None,
    realtime_telemetry: RealtimeTelemetry | None = None,
    id_factory: Callable[[], str] | None = None,
    camera_source: CameraSourceName = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
    camera_file: Path | None = None,
    trace: TraceWriter | None = None,
    metrics: MetricsSink | None = None,
    provider_tool_view: Callable[[CompiledTools], CompiledTools] | None = None,
) -> RealtimeAssembly:
    """Select a realtime provider once at startup."""
    builder = (
        build_volcengine_realtime_assembly
        if settings.realtime_provider == "volcengine"
        else build_qwen_realtime_assembly
    )
    return builder(
        settings,
        sink=sink,
        on_audio_frame=on_audio_frame,
        on_audio_clear=on_audio_clear,
        on_audio_terminal=on_audio_terminal,
        on_delivery=on_delivery,
        on_audio_alert=on_audio_alert,
        on_codex_state=on_codex_state,
        on_spoken=on_spoken,
        on_caption=on_caption,
        on_codex_project=on_codex_project,
        realtime_telemetry=realtime_telemetry,
        id_factory=id_factory,
        camera_source=camera_source,
        camera_enabled=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
        trace=trace,
        metrics=metrics,
        provider_tool_view=provider_tool_view,
    )


def _validate_provider_tool_view(full: CompiledTools, provider: CompiledTools) -> None:
    if provider.bindings is not full.bindings:
        raise ConfigurationError("provider tool view 必须复用完整 bindings")
    full_schema_names = {schema["function"]["name"] for schema in full.schemas}
    try:
        provider_schema_names = {schema["function"]["name"] for schema in provider.schemas}
    except (KeyError, TypeError) as exc:
        raise ConfigurationError("provider tool view 包含无效 schema") from exc
    if not provider_schema_names <= full_schema_names:
        raise ConfigurationError("provider tool view 不能引入未知 schema")


@dataclass(slots=True)
class _ExecutorBuildContext:
    settings: Settings
    media_store: MediaStore
    codex_live: bool
    clock: RealClock
    on_codex_project: Callable[[PublicProjectView], None] | None


def _build_fast_sim(context: _ExecutorBuildContext) -> ExecutorAdapter:
    del context
    return FastSim()


def _build_slow_sim(context: _ExecutorBuildContext) -> ExecutorAdapter:
    del context
    return SlowSim()


def _build_home_assistant(context: _ExecutorBuildContext) -> ExecutorAdapter:
    ha_url, ha_token, ha_entity_id = context.settings.require_home_assistant()
    return HomeAssistantAdapter(
        HomeAssistantTransport(ha_url, ha_token),
        entity_id=ha_entity_id,
    )


def _build_codex(context: _ExecutorBuildContext) -> ExecutorAdapter:
    workspace, binary, codex_api_key = context.settings.require_codex()
    if context.codex_live:
        managed_root, state_root = context.settings.require_codex_projects()
        store = None
        try:
            store = CodexProjectStore(state_root, managed_root, recover_starting=True)
            store.ensure_imported(workspace.name or "workspace", workspace)
        except ProjectStateError as failure:
            # Release the owner flock taken in the constructor; leaving it
            # to GC would make the next startup attempt in this process
            # fail with state_busy although nothing is running.
            if store is not None:
                store.close()
            raise ConfigurationError(f"Codex project state unavailable: {failure.code}") from None
        confirmation = ProjectConfirmationController(
            clock=context.clock,
            id_factory=lambda: uuid4().hex,
            # The realtime service publishes confirmation-only changes from
            # the adapter's cached public view; never read the registry on
            # the audio event loop.
            on_change=None,
        )

        def worker_factory(
            selected_workspace: Path,
            codex_home: Path,
            resume_thread_id: str | None,
            on_thread_ready: Callable[[str], None],
        ) -> CodexAppServerTransport:
            return CodexAppServerTransport(
                binary=binary,
                workspace=selected_workspace,
                api_key=codex_api_key,
                codex_home=codex_home,
                resume_thread_id=resume_thread_id,
                on_thread_ready=on_thread_ready,
                working_interval=context.settings.codex_working_interval,
            )

        return ProjectCodexAdapter(
            store=store,
            confirmation=confirmation,
            worker_factory=worker_factory,
            on_project_view=context.on_codex_project,
        )
    return CodexAdapter(
        CodexTransport(
            binary=binary,
            workspace=workspace,
            api_key=codex_api_key,
        )
    )


def _build_autoglm(context: _ExecutorBuildContext) -> ExecutorAdapter:
    (
        repo,
        external_python,
        model_endpoint,
        model_name,
        autoglm_api_key,
        wda_url,
        device_id,
    ) = context.settings.require_autoglm()
    try:
        runner_usable = _AUTOGLM_RUNNER_PATH.is_file()
    except OSError:
        runner_usable = False
    if not runner_usable:
        raise ConfigurationError("AutoGLM runner 文件不存在")
    return AutoGlmAdapter(
        AutoGlmTransport(
            runner_path=_AUTOGLM_RUNNER_PATH,
            external_python=external_python,
            repo=repo,
            model_endpoint=model_endpoint,
            model_name=model_name,
            api_key=autoglm_api_key.get_secret_value(),
            wda_url=wda_url,
            device_id=device_id,
        ),
        AutoGlmWdaClient(wda_url),
        context.media_store,
    )


_EXECUTOR_FACTORIES: dict[
    str,
    Callable[[_ExecutorBuildContext], ExecutorAdapter],
] = {
    "fast_sim": _build_fast_sim,
    "slow_sim": _build_slow_sim,
    "ha": _build_home_assistant,
    "codex": _build_codex,
    "autoglm": _build_autoglm,
}


def _build_assembly(
    settings: Settings,
    *,
    sink: SpeechSink,
    camera_source: CameraSourceName,
    camera_enabled: bool,
    camera_index: int,
    trace: TraceWriter | None,
    metrics: MetricsSink | None,
    codex_live: bool,
    realtime_frontbrain: bool = False,
    model_api_key_override: str | None = None,
    model_base_url_override: str | None = None,
    support_model_override: str | None = None,
    on_suggestion_selected: Callable[[Suggestion, WakeReason], None] | None,
    on_attention_decision: Callable[[AttentionDecision], None] | None,
    camera_file: Path | None = None,
    on_codex_project: Callable[[PublicProjectView], None] | None = None,
) -> Assembly:
    active_names, expected_active = _active_executor_names(settings)
    model_api_key = model_api_key_override or settings.require_api_key()
    tavily_api_key = settings.require_tavily_api_key()
    proactivity = resolve_proactivity(settings)
    clock = RealClock()
    media_store = MediaStore()
    context = _ExecutorBuildContext(
        settings=settings,
        media_store=media_store,
        codex_live=codex_live,
        clock=clock,
        on_codex_project=on_codex_project,
    )
    active_adapters = tuple(_EXECUTOR_FACTORIES[name](context) for name in active_names)
    search = SearchAdapter(TavilyTransport(tavily_api_key))
    resolved_camera = resolve_camera_source(
        active_executors=frozenset(active_names),
        requested=camera_source,
        legacy_camera=camera_enabled,
        camera_index=camera_index,
        camera_file=camera_file,
    )
    if resolved_camera == "local":
        frame_source: FrameSource = OpenCVFrameSource(
            clock=clock,
            camera_index=camera_index,
        )
    elif resolved_camera == "file":
        assert camera_file is not None
        frame_source = VideoFileFrameSource(clock, camera_file)
    else:
        frame_source = DisabledFrameSource()
    gateway = OpenAIModelGateway(
        AsyncOpenAI(
            api_key=model_api_key,
            base_url=model_base_url_override or settings.model_base_url,
        ),
        clock=clock,
        metrics=metrics,
    )
    camera = CamAdapter(frame_source, media_store)
    watch_model = (settings.watch_model or "").strip() or settings.fast_model
    if support_model_override is not None:
        watch_model = support_model_override
    surrogate_model = settings.surrogate_model
    if support_model_override is not None:
        surrogate_model = support_model_override
    compressor_model = settings.compressor_model
    if support_model_override is not None:
        compressor_model = support_model_override
    capture_enabled = not isinstance(frame_source, DisabledFrameSource)
    watch = WatchAdapter(
        WATCH_MANIFEST,
        frame_source,
        gateway,
        media_store,
        model=watch_model,
        capture_enabled=capture_enabled,
    )
    guard = WatchAdapter(
        GUARD_MANIFEST,
        frame_source,
        gateway,
        media_store,
        model=watch_model,
        capture_enabled=capture_enabled,
        # File replay has one mutable playhead. Rewinding before each Guard
        # observation keeps file-backed evaluations deterministic regardless of
        # when the observation fires.
        prepare_observation=(
            frame_source.restart if isinstance(frame_source, VideoFileFrameSource) else None
        ),
    )
    adapters = (search, camera, watch, guard, *active_adapters)
    tools = compile_tool_schema(
        tuple(adapter.manifest for adapter in adapters),
        include_memory_recall=realtime_frontbrain,
    )
    fastbrain = None
    if not realtime_frontbrain:
        fastbrain = GatewayFastBrain(
            gateway,
            model=settings.fast_model,
            tools=tools,
            media_store=media_store,
            system=FASTBRAIN_LIVE_SYSTEM if codex_live else None,
            include_trigger=codex_live,
        )
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=tuple(adapter.manifest.policy for adapter in adapters)),
        trace=trace,
        fastbrain=fastbrain,
        surrogate=GatewaySurrogate(gateway, model=surrogate_model),
        compressor=GatewayCompressor(gateway, model=compressor_model),
        executors={adapter.manifest.name: adapter for adapter in adapters},
        expected_active_executors=expected_active,
        sink=sink,
        on_suggestion_selected=on_suggestion_selected,
        on_attention_decision=on_attention_decision,
        suggestion_cooldown=proactivity.cooldown,
        fresh_window=proactivity.fresh_window,
    )
    return Assembly(
        runtime=runtime,
        gateway=gateway,
        tools=tools,
        media_store=media_store,
        frame_source=frame_source,
    )
