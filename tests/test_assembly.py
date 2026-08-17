from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from pydantic import SecretStr, ValidationError
import pytest

import nova_audio_agent.assembly as assembly_module
import nova_audio_agent.realtime.qwen as qwen_module
import nova_audio_agent.realtime.volcengine as volcengine_module
from nova_audio_agent.assembly import (
    QwenRealtimeAssembly,
    RealtimeAssembly,
    _active_executor_names,
    build_assembly,
    build_codex_live_assembly,
    build_qwen_realtime_assembly,
    build_realtime_assembly,
)
from nova_audio_agent.calls import AttentionTrigger, WatchRecord
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.events import ProgressEvent, WakeReason
from nova_audio_agent.executors.autoglm import AutoGlmAdapter
from nova_audio_agent.executors.camera import (
    DisabledFrameSource,
    OpenCVFrameSource,
    VideoFileFrameSource,
)
from nova_audio_agent.executors.codex import CODEX_POLICY, CodexAdapter
from nova_audio_agent.executors.codex_live import CodexLiveAdapter
from nova_audio_agent.executors.watcher import WatchAdapter
from nova_audio_agent.ports import Delegate, SurrogateOutput
from nova_audio_agent.realtime.protocol import SessionIdentity
from nova_audio_agent.tool_schema import CompiledTools
from nova_audio_agent.trace import TraceWriter


class _Sink:
    def emit(self, utterance_id: str, text: str) -> None:
        del utterance_id, text

    def end(self, utterance_id: str) -> None:
        del utterance_id


@pytest.mark.parametrize(
    ("provider_name", "builder_name"),
    [
        ("qwen", "build_qwen_realtime_assembly"),
        ("volcengine", "build_volcengine_realtime_assembly"),
    ],
)
def test_realtime_assembly_factory_selects_configured_provider(
    monkeypatch: pytest.MonkeyPatch,
    provider_name: str,
    builder_name: str,
) -> None:
    expected = object()
    captured: dict[str, object] = {}

    def selected(settings: Settings, **kwargs: object) -> object:
        captured["settings"] = settings
        captured.update(kwargs)
        return expected

    monkeypatch.setattr(assembly_module, builder_name, selected)
    settings = Settings(realtime_provider=provider_name, _env_file=None)

    actual = build_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )

    assert actual is expected
    assert captured["settings"] is settings


def test_qwen_realtime_assembly_remains_compatible_alias() -> None:
    assert QwenRealtimeAssembly is RealtimeAssembly


def test_volcengine_realtime_assembly_wires_native_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeVad:
        def __init__(self, config: object) -> None:
            captured["vad_config"] = config

    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(volcengine_module, "SileroVadSegmenter", FakeVad)
    settings = Settings(
        realtime_provider="volcengine",
        ark_api_key=SecretStr("ark-secret"),
        doubao_bigmodel_api_key=SecretStr("speech-secret"),
        tavily_api_key=SecretStr("search-secret"),
        codex_prewarm=False,
        _env_file=None,
    )

    assembly = assembly_module.build_volcengine_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )

    assert isinstance(assembly, RealtimeAssembly)
    assert assembly.provider._vad.__class__ is FakeVad
    assert assembly.provider._asr._chunk_bytes == 6_400
    assert captured["vad_config"].silence_end_ms == 560
    assert assembly.provider._ark._model == "doubao-seed-2-0-mini-260428"
    assert assembly.provider._tts._output_sample_rate == 24_000
    assert assembly.core.gateway._client.base_url == "https://ark.cn-beijing.volces.com/api/v3"
    assert assembly.runtime.surrogate._model == "doubao-seed-2-0-mini-260428"


def test_volcengine_ark_fallback_forces_all_support_models_to_an_ark_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeVad:
        def __init__(self, config: object) -> None:
            del config

    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **kwargs: SimpleNamespace(**kwargs))
    monkeypatch.setattr(volcengine_module, "SileroVadSegmenter", FakeVad)
    settings = Settings(
        realtime_provider="volcengine",
        ark_api_key=SecretStr("ark-secret"),
        doubao_bigmodel_api_key=SecretStr("speech-secret"),
        tavily_api_key=SecretStr("search-secret"),
        fast_model="qwen3-vl-plus",
        surrogate_model="qwen-plus",
        compressor_model="qwen-flash",
        codex_prewarm=False,
        _env_file=None,
    )

    assembly = assembly_module.build_volcengine_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )

    expected = "doubao-seed-2-0-mini-260428"
    assert assembly.runtime.executors["watch"]._model == expected
    assert assembly.runtime.executors["guard"]._model == expected
    assert assembly.runtime.surrogate._model == expected
    assert assembly.runtime.compressor._model == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("codex,autoglm", ("codex", "autoglm")),
        (" autoglm , codex ", ("autoglm", "codex")),
    ],
)
def test_explicit_executor_order_is_normalized(
    raw: str,
    expected: tuple[str, ...],
) -> None:
    names, explicit = _active_executor_names(
        Settings(executor="fast_sim", executors=raw, _env_file=None)
    )

    assert names == expected
    assert explicit == frozenset(expected)


def test_empty_executor_list_uses_legacy_single_value() -> None:
    names, explicit = _active_executor_names(
        Settings(executor="codex", executors="", _env_file=None)
    )

    assert names == ("codex",)
    assert explicit is None


@pytest.mark.parametrize(
    "raw",
    ["codex,,autoglm", "codex, ,autoglm", "codex,codex", " ", "unknown"],
)
def test_invalid_explicit_executor_list_is_rejected(raw: str) -> None:
    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_EXECUTORS"):
        _active_executor_names(Settings(executors=raw, _env_file=None))


def test_watch_model_defaults_to_fast_model_at_use_site() -> None:
    settings = Settings(fast_model="fast-vl", _env_file=None)

    assert (settings.watch_model or settings.fast_model) == "fast-vl"


def test_production_assembly_loads_search_plus_one_active_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="slow_sim",
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert list(assembly.runtime.executors) == ["search", "cam", "watch", "guard", "slow_sim"]
    assert set(assembly.runtime.memory.policies) == {
        "conversation",
        "search",
        "cam",
        "watch",
        "guard",
        "slow_sim",
    }
    assert isinstance(assembly.frame_source, DisabledFrameSource)
    assert assembly.media_store.total_bytes == 0
    assert isinstance(assembly.runtime.executors["watch"], WatchAdapter)
    assert isinstance(assembly.runtime.executors["guard"], WatchAdapter)
    assert assembly.runtime.executors["watch"]._source is assembly.frame_source
    assert assembly.runtime.executors["guard"]._source is assembly.frame_source
    tool_names = [schema["function"]["name"] for schema in assembly.tools.schemas]
    assert tool_names == [
        "update_intent",
        "update_goal",
        "update_authorization",
        "search__search",
        "cam__snapshot",
        "watch__start",
        "watch__stop",
        "watch__status",
        "guard__start",
        "guard__stop",
        "guard__status",
        "slow_sim__set_light",
        "slow_sim__get_state",
    ]


def test_production_assembly_loads_search_plus_home_assistant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="ha",
        ha_url="http://homeassistant.local:8123/",
        ha_token=SecretStr("ha-private-token"),
        ha_entity_id="light.bedside_lamp",
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert set(assembly.runtime.executors) == {"search", "cam", "watch", "guard", "ha"}
    assert set(assembly.runtime.memory.policies) == {
        "conversation",
        "search",
        "cam",
        "watch",
        "guard",
        "ha",
    }
    tool_names = [schema["function"]["name"] for schema in assembly.tools.schemas]
    assert tool_names == [
        "update_intent",
        "update_goal",
        "update_authorization",
        "search__search",
        "cam__snapshot",
        "watch__start",
        "watch__stop",
        "watch__status",
        "guard__start",
        "guard__stop",
        "guard__status",
        "ha__get_state",
        "ha__set_light",
    ]


def test_simulator_assembly_does_not_require_home_assistant_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="fast_sim",
        ha_url=None,
        ha_token=None,
        ha_entity_id=None,
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert set(assembly.runtime.executors) == {"search", "cam", "watch", "guard", "fast_sim"}


def test_production_assembly_loads_search_plus_codex_in_fixed_order(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        codex_bin="/opt/tools/codex",
        codex_api_key=SecretStr("codex-private-key"),
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert list(assembly.runtime.executors) == ["search", "cam", "watch", "guard", "codex"]
    assert isinstance(assembly.runtime.executors["codex"], CodexAdapter)
    assert assembly.runtime.memory.policies["codex"] == CODEX_POLICY
    assert assembly.runtime.memory.policies["codex"].progress_via_surrogate is True
    assert set(assembly.runtime.memory.policies) == {
        "conversation",
        "search",
        "cam",
        "watch",
        "guard",
        "codex",
    }
    tool_names = [schema["function"]["name"] for schema in assembly.tools.schemas]
    assert tool_names == [
        "update_intent",
        "update_goal",
        "update_authorization",
        "search__search",
        "cam__snapshot",
        "watch__start",
        "watch__stop",
        "watch__status",
        "guard__start",
        "guard__stop",
        "guard__status",
        "codex__run",
        "codex__status",
    ]
    manifests = tuple(adapter.manifest for adapter in assembly.runtime.executors.values())
    assert sum(any(not op.readonly for op in manifest.ops) for manifest in manifests) == 1


def test_explicit_live_assembly_adds_steer_without_changing_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        codex_bin="/opt/tools/codex",
        codex_api_key=SecretStr("codex-private-key"),
        _env_file=None,
    )

    live = build_codex_live_assembly(settings, sink=_Sink())
    default = build_assembly(settings, sink=_Sink())

    assert isinstance(live.runtime.executors["codex"], CodexLiveAdapter)
    assert isinstance(default.runtime.executors["codex"], CodexAdapter)
    assert "codex.steer" in live.runtime.fastbrain._system
    assert "codex.steer" not in default.runtime.fastbrain._system
    live_tools = [schema["function"]["name"] for schema in live.tools.schemas]
    default_tools = [schema["function"]["name"] for schema in default.tools.schemas]
    assert live_tools[-3:] == ["codex__run", "codex__steer", "codex__status"]
    assert default_tools[-2:] == ["codex__run", "codex__status"]


def test_explicit_qwen_realtime_assembly_reuses_live_manifest_without_fastbrain(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    qwen_calls: list[dict[str, object]] = []
    model_calls: list[dict[str, object]] = []

    class _Provider:
        def __init__(self, **kwargs) -> None:
            qwen_calls.append(kwargs)

    monkeypatch.setattr(
        assembly_module,
        "AsyncOpenAI",
        lambda **kwargs: model_calls.append(kwargs) or object(),
    )
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", _Provider)
    settings = Settings(
        model_api_key=SecretStr("shared-dashscope-key"),
        dashscope_api_key=SecretStr("realtime-dashscope-key"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        qwen_realtime_url="wss://dashscope.example/realtime",
        qwen_realtime_model="qwen-audio-3.0-realtime-plus",
        qwen_realtime_voice="longanqian",
        _env_file=None,
    )

    states: list[str] = []
    alerts: list[tuple[str | None, int | None]] = []
    realtime = build_qwen_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_alert=lambda utterance_id, epoch: alerts.append((utterance_id, epoch)),
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_codex_state=states.append,
        on_spoken=lambda _text: None,
        on_delivery=lambda _completion: None,
    )
    default = build_assembly(settings, sink=_Sink())

    assert isinstance(realtime.runtime.executors["codex"], CodexLiveAdapter)
    assert isinstance(default.runtime.executors["codex"], CodexAdapter)
    assert realtime.runtime.fastbrain is None
    assert default.runtime.fastbrain is not None
    assert [schema["function"]["name"] for schema in realtime.tools.schemas][-3:] == [
        "codex__run",
        "codex__steer",
        "codex__status",
    ]
    assert qwen_calls == [
        {
            "url": "wss://dashscope.example/realtime",
            "api_key": "realtime-dashscope-key",
            "model": "qwen-audio-3.0-realtime-plus",
            "voice": "longanqian",
        }
    ]
    assert model_calls[0]["api_key"] == "shared-dashscope-key"
    generation = realtime.service.session._playback.open_response(
        session_epoch=1,
        response_id="old-response",
    )
    assert realtime.service.session._playback.fence_current(alert=True) == generation
    assert alerts == [(generation.utterance_id, generation.generation_epoch)]
    realtime.runtime.delegates.dispatch(
        Delegate(
            delegate_id="delegate-1",
            executor="codex",
            op="run",
            request={},
            origin_ref="conversation:1",
            deadline=30.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    realtime.service.project_runtime_event(
        ProgressEvent(
            channel="codex",
            delegate_id="delegate-1",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=0.5,
        )
    )
    assert states == ["running"]


def test_qwen_controlled_guard_reconnect_and_history_arm_are_opt_in_at_assembly(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(
        qwen_module,
        "QwenAudioRealtimeAdapter",
        lambda **_kwargs: object(),
    )

    def build(enabled: bool, history: str = "none"):
        return build_qwen_realtime_assembly(
            Settings(
                model_api_key=SecretStr("model-key"),
                dashscope_api_key=SecretStr("realtime-key"),
                tavily_api_key=SecretStr("tavily-key"),
                executor="codex",
                codex_workspace=tmp_path,
                qwen_controlled_guard_reconnect=enabled,
                qwen_guard_history_recovery=history,
                _env_file=None,
            ),
            sink=_Sink(),
            on_audio_frame=lambda _frame: None,
            on_audio_clear=lambda _utterance_id, _epoch: None,
            on_audio_terminal=lambda _utterance_id, _epoch: None,
            on_delivery=lambda _completion: None,
        )

    assert build(False).service._controlled_guard_reconnect is False
    assert build(True).service._controlled_guard_reconnect is True
    assert build(False).service._guard_history_recovery == "none"
    assert build(True, "packed").service._guard_history_recovery == "packed"


@pytest.mark.parametrize(("raw", "expected"), [("1", 1), ("2", 2), ("4", 4)])
def test_qwen_history_pair_budget_parses_from_environment(
    monkeypatch: pytest.MonkeyPatch,
    raw: str,
    expected: int,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS", raw)

    assert Settings(_env_file=None).qwen_guard_history_pairs == expected


def test_rejected_native_history_arm_is_not_a_runtime_setting() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, qwen_guard_history_recovery="native")


@pytest.mark.asyncio
async def test_qwen_realtime_provider_tool_view_narrows_provider_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    connected_tools: list[tuple[dict[str, object], ...]] = []

    class _Provider:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def connect(self, *, tools: tuple[dict[str, object], ...]) -> SessionIdentity:
            connected_tools.append(tools)
            return SessionIdentity(1, "provider-session")

    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", _Provider)
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        dashscope_api_key=SecretStr("realtime-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        _env_file=None,
    )

    def guard_view(tools: CompiledTools) -> CompiledTools:
        schemas = tuple(
            schema
            for schema in tools.schemas
            if schema["function"]["name"] in {"guard__start", "guard__status"}
        )
        return CompiledTools(schemas=schemas, bindings=tools.bindings)

    realtime = build_qwen_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
        provider_tool_view=guard_view,
    )
    full_bindings = realtime.tools.bindings

    assert full_bindings["memory__recall"].kind == "query"

    await realtime.service.connect()

    assert [schema["function"]["name"] for schema in connected_tools[0]] == [
        "guard__start",
        "guard__status",
    ]
    assert realtime.tools.bindings is full_bindings
    assert realtime.service._tools.bindings is full_bindings
    assert realtime.service._bridge._tools.bindings is full_bindings


@pytest.mark.parametrize("invalid_view", ["copied_bindings", "unknown_schema"])
def test_qwen_realtime_provider_tool_view_rejects_authority_expansion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    invalid_view: str,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        dashscope_api_key=SecretStr("realtime-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        _env_file=None,
    )

    def invalid(tools: CompiledTools) -> CompiledTools:
        if invalid_view == "copied_bindings":
            return CompiledTools(schemas=tools.schemas, bindings=dict(tools.bindings))
        return CompiledTools(
            schemas=({"type": "function", "function": {"name": "unknown__tool"}},),
            bindings=tools.bindings,
        )

    with pytest.raises(ConfigurationError, match="provider tool view"):
        build_qwen_realtime_assembly(
            settings,
            sink=_Sink(),
            on_audio_frame=lambda _frame: None,
            on_audio_clear=lambda _utterance_id, _epoch: None,
            on_audio_terminal=lambda _utterance_id, _epoch: None,
            on_delivery=lambda _completion: None,
            provider_tool_view=invalid,
        )


def test_invalid_explicit_set_fails_before_realtime_provider_creation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        qwen_module,
        "QwenAudioRealtimeAdapter",
        lambda **kwargs: provider_calls.append(kwargs) or object(),
    )
    settings = Settings(executors="codex,,autoglm", _env_file=None)

    with pytest.raises(ConfigurationError, match="空名称"):
        build_qwen_realtime_assembly(
            settings,
            sink=_Sink(),
            on_audio_frame=lambda _frame: None,
            on_audio_clear=lambda _utterance_id, _epoch: None,
            on_audio_terminal=lambda _utterance_id, _epoch: None,
            on_delivery=lambda _completion: None,
        )

    assert provider_calls == []


def test_qwen_realtime_assembly_accepts_non_codex_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        dashscope_api_key=SecretStr("realtime-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="fast_sim",
        _env_file=None,
    )

    realtime = build_qwen_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_codex_state=lambda _state: None,
        on_spoken=lambda _text: None,
        on_delivery=lambda _completion: None,
    )

    assert list(realtime.runtime.executors)[-1] == "fast_sim"
    assert realtime.codex_live_adapter is None


def test_qwen_realtime_assembly_wires_suggestion_callback_after_service_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        _env_file=None,
    )
    realtime = build_qwen_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )
    suggestion = realtime.runtime.suggestions.add(
        origin="executor",
        kind="notify",
        content={"observation": "桌面上出现水杯"},
        evidence_refs=("watch:1",),
        salience=40.0,
    )

    realtime.runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind="handoff",
                priority=40,
                routing_class="ambient",
                origin="watch:1",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id=suggestion.id,
                reason="worth mentioning",
            ),
            offered=(suggestion.id,),
        )
    )

    suggestion_items = [
        queued
        for queued in realtime.service._host_items
        if queued.intent.item.event_id == f"suggestion:{suggestion.id}"
    ]
    assert len(suggestion_items) == 1
    assert suggestion_items[0].intent.item.content == "桌面上出现水杯"
    assert realtime.runtime.suggestions.get(suggestion.id).status == "pending"


def test_qwen_realtime_assembly_relays_attention_decision_to_service_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    records: list[tuple[str, dict[str, object]]] = []

    class _Telemetry:
        def record(self, kind: str, payload: dict[str, object]) -> None:
            records.append((kind, payload))

    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: object())
    realtime = build_qwen_realtime_assembly(
        Settings(
            model_api_key=SecretStr("model-secret"),
            tavily_api_key=SecretStr("tavily-secret"),
            executor="codex",
            codex_workspace=tmp_path,
            _env_file=None,
        ),
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
        realtime_telemetry=_Telemetry(),  # type: ignore[arg-type]
    )
    realtime.runtime.delegates.dispatch(
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
    now = realtime.runtime.clock.now()
    realtime.runtime.apply(
        ProgressEvent(
            channel="codex",
            delegate_id="d-codex",
            op="run",
            phase="working",
            internal_activity=1,
            elapsed=2.0,
            summary=("进度内容哨兵 查询哨兵 参数哨兵 /private/路径哨兵 provider-id-sentinel"),
            ts=now,
            seq=1,
        )
    )
    suggestion = realtime.runtime.suggestions.all()[0]

    realtime.runtime._consume_watch(
        WatchRecord(
            reason=WakeReason(
                kind=ProgressEvent.KIND,
                priority=CODEX_POLICY.priority,
                routing_class="ambient",
                origin="d-codex",
            ),
            output=SurrogateOutput(
                speak=True,
                suggestion_id=suggestion.id,
                reason="Surrogate 原因哨兵",
            ),
            offered=(suggestion.id,),
            trigger=AttentionTrigger(
                suggestion_id=suggestion.id,
                delegate_id="d-codex",
                channel="codex",
                memory_ref="codex:1",
            ),
        )
    )

    assert [record for record in records if record[0] == "attention.decision"] == [
        (
            "attention.decision",
            {
                "channel": "codex",
                "memory_ref": "codex:1",
                "speak": True,
                "selected": True,
            },
        )
    ]
    serialized = str(records)
    for sentinel in (
        "进度内容哨兵",
        "Surrogate 原因哨兵",
        "查询哨兵",
        "参数哨兵",
        "/private/路径哨兵",
        "provider-id-sentinel",
    ):
        assert sentinel not in serialized


def test_qwen_realtime_key_prefers_dashscope_and_falls_back_to_model_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preferred = Settings(
        dashscope_api_key=SecretStr("realtime-key"),
        model_api_key=SecretStr("model-key"),
        _env_file=None,
    )
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    fallback = Settings(model_api_key=SecretStr("model-key"), _env_file=None)

    assert preferred.require_qwen_realtime()[-1] == "realtime-key"
    assert fallback.require_qwen_realtime()[-1] == "model-key"


@pytest.mark.parametrize(
    ("codex_secret", "expected_codex_key"),
    (
        (SecretStr("codex-private-key"), "codex-private-key"),
        (None, None),
    ),
    ids=("one-shot-key", "saved-login"),
)
def test_codex_assembly_never_shadows_model_and_worker_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    codex_secret: SecretStr | None,
    expected_codex_key: str | None,
) -> None:
    model_calls: list[dict[str, object]] = []
    transport_calls: list[dict[str, object]] = []

    def fake_openai(**kwargs):
        model_calls.append(kwargs)
        return object()

    def fake_transport(**kwargs):
        transport_calls.append(kwargs)
        return object()

    monkeypatch.setattr(assembly_module, "AsyncOpenAI", fake_openai)
    monkeypatch.setattr(assembly_module, "CodexTransport", fake_transport)
    settings = Settings(
        model_api_key=SecretStr("model-private-key"),
        tavily_api_key=SecretStr("tavily-private-key"),
        executor="codex",
        codex_workspace=tmp_path,
        codex_api_key=codex_secret,
        _env_file=None,
    )

    build_assembly(settings, sink=_Sink())

    assert model_calls == [
        {
            "api_key": "model-private-key",
            "base_url": settings.model_base_url,
        }
    ]
    assert transport_calls == [
        {
            "binary": "codex",
            "workspace": tmp_path.resolve(),
            "api_key": expected_codex_key,
        }
    ]
    assert model_calls[0]["api_key"] != transport_calls[0]["api_key"]


def test_non_codex_assembly_does_not_require_codex_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="fast_sim",
        codex_workspace=None,
        codex_bin=" ",
        codex_api_key=SecretStr("unused-private-key"),
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert set(assembly.runtime.executors) == {"search", "cam", "watch", "guard", "fast_sim"}


def test_production_assembly_builds_autoglm_with_separate_worker_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    model_calls: list[dict[str, object]] = []
    transport_calls: list[dict[str, object]] = []
    wda_calls: list[str] = []
    repo = tmp_path / "Open-AutoGLM"
    repo.mkdir()
    external_python = tmp_path / "autoglm-python"
    external_python.write_text("", encoding="utf-8")

    monkeypatch.setattr(
        assembly_module,
        "AsyncOpenAI",
        lambda **kwargs: model_calls.append(kwargs) or object(),
    )
    monkeypatch.setattr(
        assembly_module,
        "AutoGlmTransport",
        lambda **kwargs: transport_calls.append(kwargs) or object(),
    )
    monkeypatch.setattr(
        assembly_module,
        "AutoGlmWdaClient",
        lambda url: wda_calls.append(url) or object(),
    )
    settings = Settings(
        model_api_key=SecretStr("model-private-key"),
        tavily_api_key=SecretStr("tavily-private-key"),
        executor="autoglm",
        autoglm_repo=repo,
        autoglm_python=str(external_python),
        autoglm_base_url="https://model.example/v1/",
        autoglm_model="autoglm-phone",
        autoglm_api_key=SecretStr("autoglm-private-key"),
        autoglm_wda_url="http://127.0.0.1:8100/",
        autoglm_device_id="device-123",
        _env_file=None,
    )

    assembly = build_assembly(settings, sink=_Sink())

    assert list(assembly.runtime.executors) == ["search", "cam", "watch", "guard", "autoglm"]
    adapter = assembly.runtime.executors["autoglm"]
    assert isinstance(adapter, AutoGlmAdapter)
    assert adapter._store is assembly.media_store
    assert model_calls == [
        {
            "api_key": "model-private-key",
            "base_url": settings.model_base_url,
        }
    ]
    assert transport_calls == [
        {
            "runner_path": Path(__file__).parents[1] / "scripts" / "autoglm_ios_runner.py",
            "external_python": str(external_python.resolve()),
            "repo": repo.resolve(),
            "model_endpoint": "https://model.example/v1",
            "model_name": "autoglm-phone",
            "api_key": "autoglm-private-key",
            "wda_url": "http://127.0.0.1:8100",
            "device_id": "device-123",
        }
    ]
    assert wda_calls == ["http://127.0.0.1:8100"]


def test_production_assembly_rejects_a_missing_autoglm_runner_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "Open-AutoGLM"
    repo.mkdir()
    external_python = tmp_path / "autoglm-python"
    external_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(
        assembly_module,
        "_AUTOGLM_RUNNER_PATH",
        tmp_path / "missing-autoglm-runner.py",
    )
    settings = Settings(
        model_api_key=SecretStr("model-private-key"),
        tavily_api_key=SecretStr("tavily-private-key"),
        executor="autoglm",
        autoglm_repo=repo,
        autoglm_python=str(external_python),
        autoglm_api_key=SecretStr("autoglm-private-key"),
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="AutoGLM runner"):
        build_assembly(settings, sink=_Sink())


def test_codex_live_assembly_requires_codex_when_autoglm_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(executor="autoglm", _env_file=None)

    with pytest.raises(ConfigurationError, match="codex executor"):
        build_codex_live_assembly(settings, sink=_Sink())


async def test_camera_enabled_assembly_builds_but_does_not_start_the_real_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="fast_sim",
        _env_file=None,
    )

    assembly = build_assembly(
        settings,
        sink=_Sink(),
        camera_enabled=True,
        camera_index=2,
    )

    assert isinstance(assembly.frame_source, OpenCVFrameSource)
    assert await assembly.frame_source.snapshot() is None


def test_file_camera_assembly_restarts_only_guard_observations(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="fast_sim",
        _env_file=None,
    )

    assembly = build_assembly(
        settings,
        sink=_Sink(),
        camera_source="file",
        camera_file=video,
    )

    assert isinstance(assembly.frame_source, VideoFileFrameSource)
    watch = assembly.runtime.executors["watch"]
    guard = assembly.runtime.executors["guard"]
    assert isinstance(watch, WatchAdapter)
    assert isinstance(guard, WatchAdapter)
    assert watch._prepare_observation is None
    assert guard._prepare_observation == assembly.frame_source.restart
    local = build_assembly(settings, sink=_Sink(), camera_source="local")
    local_guard = local.runtime.executors["guard"]
    assert isinstance(local_guard, WatchAdapter)
    assert local_guard._prepare_observation is None


def test_assembly_passes_an_explicit_trace_writer_to_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        _env_file=None,
    )
    with TraceWriter(tmp_path / "trace.jsonl") as trace:
        assembly = build_assembly(settings, sink=_Sink(), trace=trace)

        assert assembly.runtime._trace is trace


class _PrewarmCore:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


class _PrewarmService:
    def __init__(self) -> None:
        self.started = False
        self.closed = False

    async def start(self) -> None:
        self.started = True

    async def close(self) -> None:
        self.closed = True


class _PrewarmAdapter:
    def __init__(self) -> None:
        self.prewarm_entered = asyncio.Event()
        self.gate = asyncio.Event()
        self.prewarm_calls = 0
        self.aclose_calls = 0

    async def prewarm(self) -> None:
        self.prewarm_calls += 1
        self.prewarm_entered.set()
        await self.gate.wait()

    async def aclose(self) -> None:
        self.aclose_calls += 1


async def test_qwen_realtime_start_schedules_prewarm_without_blocking() -> None:
    """Session startup must not wait on the <=20s Codex preflight (R102)."""
    adapter = _PrewarmAdapter()
    assembly = QwenRealtimeAssembly(
        core=_PrewarmCore(),  # type: ignore[arg-type]
        provider=object(),  # type: ignore[arg-type]
        service=_PrewarmService(),  # type: ignore[arg-type]
        codex_live_adapter=adapter,  # type: ignore[arg-type]
    )

    await assembly.start()  # returns although prewarm never resolves

    await asyncio.wait_for(adapter.prewarm_entered.wait(), timeout=1.0)
    assert adapter.prewarm_calls == 1

    await assembly.stop()  # must not hang on the stuck prewarm task

    assert adapter.aclose_calls == 1
    assert assembly.core.stopped is True  # type: ignore[union-attr]
    assert assembly.service.closed is True  # type: ignore[union-attr]


async def test_qwen_realtime_prewarm_toggle_off_keeps_lazy_behaviour() -> None:
    adapter = _PrewarmAdapter()
    assembly = QwenRealtimeAssembly(
        core=_PrewarmCore(),  # type: ignore[arg-type]
        provider=object(),  # type: ignore[arg-type]
        service=_PrewarmService(),  # type: ignore[arg-type]
        codex_live_adapter=adapter,  # type: ignore[arg-type]
        codex_prewarm=False,
    )

    await assembly.start()
    for _ in range(3):
        await asyncio.sleep(0)

    assert adapter.prewarm_calls == 0

    await assembly.stop()

    assert adapter.aclose_calls == 1  # teardown still owns the worker lifecycle


def test_qwen_realtime_build_exposes_the_live_adapter_handle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(assembly_module, "AsyncOpenAI", lambda **_kwargs: object())
    monkeypatch.setattr(qwen_module, "QwenAudioRealtimeAdapter", lambda **_kwargs: object())
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        _env_file=None,
    )
    assert settings.codex_prewarm is True

    realtime = build_qwen_realtime_assembly(
        settings,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )

    assert realtime.codex_live_adapter is realtime.runtime.executors["codex"]
    assert realtime.codex_prewarm is True

    lazy = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        executor="codex",
        codex_workspace=tmp_path,
        codex_prewarm=False,
        _env_file=None,
    )
    off = build_qwen_realtime_assembly(
        lazy,
        sink=_Sink(),
        on_audio_frame=lambda _frame: None,
        on_audio_clear=lambda _utterance_id, _epoch: None,
        on_audio_terminal=lambda _utterance_id, _epoch: None,
        on_delivery=lambda _completion: None,
    )
    assert off.codex_prewarm is False
