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
from nova_audio_agent.config import ConfigurationError, Settings
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
from nova_audio_agent.speech import SpeechSink
from nova_audio_agent.suggestions import Suggestion
from nova_audio_agent.tool_schema import CompiledTools, compile_tool_schema
from nova_audio_agent.trace import TraceWriter

if TYPE_CHECKING:
    from nova_audio_agent.realtime.playback import PlaybackCompletion, PlaybackFrame
    from nova_audio_agent.realtime.qwen import QwenAudioRealtimeAdapter
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
class QwenRealtimeAssembly:
    core: Assembly
    provider: QwenAudioRealtimeAdapter
    service: RealtimeService
    codex_live_adapter: CodexLiveAdapter | None = None
    codex_prewarm: bool = True
    _prewarm_task: asyncio.Task[None] | None = None

    @property
    def runtime(self) -> Runtime:
        return self.core.runtime

    @property
    def tools(self) -> CompiledTools:
        return self.core.tools

    async def start(self) -> None:
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
                if self.codex_live_adapter is not None:
                    await self.codex_live_adapter.aclose()


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
) -> QwenRealtimeAssembly:
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
        on_codex_project=on_codex_project,
    )
    provider_tools = core.tools if provider_tool_view is None else provider_tool_view(core.tools)
    if provider_tools.bindings is not core.tools.bindings:
        raise ConfigurationError("provider tool view 必须复用完整 bindings")
    full_schema_names = {schema["function"]["name"] for schema in core.tools.schemas}
    try:
        provider_schema_names = {schema["function"]["name"] for schema in provider_tools.schemas}
    except (KeyError, TypeError) as exc:
        raise ConfigurationError("provider tool view 包含无效 schema") from exc
    if not provider_schema_names <= full_schema_names:
        raise ConfigurationError("provider tool view 不能引入未知 schema")
    provider = QwenAudioRealtimeAdapter(
        url=url,
        api_key=realtime_api_key,
        model=model,
        voice=voice,
    )
    next_id = (lambda: f"nova_{uuid4().hex}") if id_factory is None else id_factory
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
        project_confirmation=(
            live_adapter.confirmation
            if isinstance(live_adapter := core.runtime.executors.get("codex"), ProjectCodexAdapter)
            else None
        ),
        commit_project_operation=(
            (
                lambda operation, origin_ref: live_adapter.commit_confirmed(
                    operation,
                    origin_ref=origin_ref,
                    runtime_dispatch=core.runtime.dispatch_external,
                )
            )
            if isinstance(live_adapter, ProjectCodexAdapter)
            else None
        ),
        on_project_view=(
            (
                lambda view: on_codex_project(
                    live_adapter.store.public_view(pending_confirmation=view.pending_confirmation)
                )
            )
            if isinstance(live_adapter, ProjectCodexAdapter) and on_codex_project is not None
            else None
        ),
    )
    suggestion_outlet = service.on_suggestion_selected
    attention_outlet = service.on_attention_decision
    live_adapter = core.runtime.executors.get("codex")
    return QwenRealtimeAssembly(
        core=core,
        provider=provider,
        service=service,
        codex_live_adapter=(live_adapter if isinstance(live_adapter, CodexLiveAdapter) else None),
        codex_prewarm=settings.codex_prewarm and not isinstance(live_adapter, ProjectCodexAdapter),
    )


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
        if context.settings.codex_projects_enabled:
            managed_root, state_root = context.settings.require_codex_projects()
            try:
                store = CodexProjectStore(state_root, managed_root, recover_starting=True)
                store.ensure_imported(workspace.name or "workspace", workspace)
            except ProjectStateError as failure:
                raise ConfigurationError(
                    f"Codex project state unavailable: {failure.code}"
                ) from None
            confirmation = ProjectConfirmationController(
                clock=context.clock,
                id_factory=lambda: uuid4().hex,
                on_change=(
                    (
                        lambda view: context.on_codex_project(
                            store.public_view(pending_confirmation=view.pending_confirmation)
                        )
                    )
                    if context.on_codex_project is not None
                    else None
                ),
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
                )

            return ProjectCodexAdapter(
                store=store,
                confirmation=confirmation,
                worker_factory=worker_factory,
                on_project_view=context.on_codex_project,
            )
        return CodexLiveAdapter(
            CodexAppServerTransport(
                binary=binary,
                workspace=workspace,
                api_key=codex_api_key,
            )
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
    on_suggestion_selected: Callable[[Suggestion, WakeReason], None] | None,
    on_attention_decision: Callable[[AttentionDecision], None] | None,
    camera_file: Path | None = None,
    on_codex_project: Callable[[PublicProjectView], None] | None = None,
) -> Assembly:
    active_names, expected_active = _active_executor_names(settings)
    model_api_key = model_api_key_override or settings.require_api_key()
    tavily_api_key = settings.require_tavily_api_key()
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
        AsyncOpenAI(api_key=model_api_key, base_url=settings.model_base_url),
        clock=clock,
        metrics=metrics,
    )
    camera = CamAdapter(frame_source, media_store)
    watch_model = (settings.watch_model or "").strip() or settings.fast_model
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
        surrogate=GatewaySurrogate(gateway, model=settings.surrogate_model),
        compressor=GatewayCompressor(gateway, model=settings.compressor_model),
        executors={adapter.manifest.name: adapter for adapter in adapters},
        expected_active_executors=expected_active,
        sink=sink,
        on_suggestion_selected=on_suggestion_selected,
        on_attention_decision=on_attention_decision,
    )
    return Assembly(
        runtime=runtime,
        gateway=gateway,
        tools=tools,
        media_store=media_store,
        frame_source=frame_source,
    )
