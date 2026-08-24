"""Export/check the Python-owned v1 production configuration contract."""

from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from unittest.mock import patch

from pydantic import ValidationError

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.assembly import _active_executor_names  # noqa: E402
from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.config import ConfigurationError, Settings, resolve_proactivity  # noqa: E402

FIXTURE_ROOT = REPOSITORY_ROOT / "fixtures" / "config" / "v1"
SECRET_FIELDS = {
    "model_api_key",
    "tavily_api_key",
    "dashscope_api_key",
    "ark_api_key",
    "doubao_asr_api_key",
    "doubao_bigmodel_api_key",
    "codex_api_key",
}
RETIRED_FIELDS = {
    "ha_url",
    "ha_token",
    "ha_entity_id",
    "autoglm_repo",
    "autoglm_python",
    "autoglm_base_url",
    "autoglm_model",
    "autoglm_api_key",
    "autoglm_wda_url",
    "autoglm_device_id",
}


def _cases() -> list[dict[str, Any]]:
    return [
        {"id": "defaults", "action": "load", "environment": {}},
        {
            "id": "all_preserved_overrides",
            "action": "load",
            "environment": {
                "NOVA_AUDIO_AGENT_MODEL_BASE_URL": "https://model.example/v1",
                "NOVA_AUDIO_AGENT_MODEL_API_KEY": "fixture-model-key",
                "NOVA_AUDIO_AGENT_FAST_MODEL": "fast-astral-😀",
                "NOVA_AUDIO_AGENT_WATCH_MODEL": "watch-😀",
                "NOVA_AUDIO_AGENT_SURROGATE_MODEL": "surrogate",
                "NOVA_AUDIO_AGENT_COMPRESSOR_MODEL": "compressor",
                "NOVA_AUDIO_AGENT_REALTIME_PROVIDER": "volcengine",
                "NOVA_AUDIO_AGENT_QWEN_REALTIME_URL": "wss://qwen.example/realtime",
                "NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL": "qwen-model",
                "NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE": "voice",
                "NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT": "true",
                "NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_RECOVERY": "packed",
                "NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS": "2",
                "DASHSCOPE_API_KEY": "fixture-dash-key",
                "ARK_API_KEY": "fixture-ark-key",
                "DOUBAO_ASR_API_KEY": "fixture-asr-key",
                "DOUBAO_BIGMODEL_API_KEY": "fixture-tts-key",
                "NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL": "https://ark.example/v3/",
                "NOVA_AUDIO_AGENT_VOLCENGINE_ARK_MODEL": "ark-primary",
                "NOVA_AUDIO_AGENT_VOLCENGINE_ARK_SUPPORT_MODEL": "ark-support",
                "NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT": "wss://asr.example/ws/",
                "NOVA_AUDIO_AGENT_DOUBAO_ASR_RESOURCE_ID": "asr-resource",
                "NOVA_AUDIO_AGENT_DOUBAO_ASR_CHUNK_MS": "320",
                "NOVA_AUDIO_AGENT_DOUBAO_TTS_ENDPOINT": "wss://tts.example/ws/",
                "NOVA_AUDIO_AGENT_DOUBAO_TTS_RESOURCE_ID": "tts-resource",
                "NOVA_AUDIO_AGENT_DOUBAO_TTS_VOICE": "tts-voice",
                "NOVA_AUDIO_AGENT_DOUBAO_TTS_OUTPUT_SAMPLE_RATE": "24000",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_THRESHOLD": "0.75",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_PRE_ROLL_MS": "300",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MIN_SPEECH_MS": "280",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SILENCE_END_MS": "600",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_SPEECH_PAD_MS": "40",
                "NOVA_AUDIO_AGENT_VOLCENGINE_VAD_MAX_UTTERANCE_MS": "16000",
                "NOVA_AUDIO_AGENT_EXECUTOR": "codex",
                "NOVA_AUDIO_AGENT_EXECUTORS": "slow_sim,codex",
                "NOVA_AUDIO_AGENT_CODEX_WORKSPACE": "/fixture/workspace",
                "NOVA_AUDIO_AGENT_CODEX_BIN": "/fixture/bin/codex",
                "NOVA_AUDIO_AGENT_CODEX_API_KEY": "fixture-codex-key",
                "NOVA_AUDIO_AGENT_CODEX_PREWARM": "false",
                "NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT": "/fixture/managed",
                "NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT": "/fixture/state",
                "NOVA_AUDIO_AGENT_PROACTIVITY_PRESET": "eager",
                "NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL": "5",
                "NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN": "7.5",
                "NOVA_AUDIO_AGENT_FRESH_WINDOW": "9.25",
                "TAVILY_API_KEY": "fixture-tavily-key",
            },
        },
        {
            "id": "python_only_whitespace",
            "action": "load",
            "environment": {
                "NOVA_AUDIO_AGENT_FAST_MODEL": "\u001cfast\u0085",
                "NOVA_AUDIO_AGENT_EXECUTORS": "\u001cslow_sim\u0085, fast_sim ",
                "NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL": "\u001c5\u0085",
                "NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN": "\u001c0\u0085",
                "TAVILY_API_KEY": "\u001ctavily\u0085",
            },
        },
        {
            "id": "python_only_string_whitespace",
            "action": "load",
            "environment": {
                "NOVA_AUDIO_AGENT_FAST_MODEL": "\u001cfast\u0085",
                "NOVA_AUDIO_AGENT_WATCH_MODEL": "\u001cwatch\u0085",
                "NOVA_AUDIO_AGENT_EXECUTORS": "\u001cslow_sim\u0085, fast_sim ",
                "TAVILY_API_KEY": "\u001ctavily\u0085",
            },
        },
        {
            "id": "bom_is_not_python_whitespace",
            "action": "load",
            "environment": {
                "NOVA_AUDIO_AGENT_FAST_MODEL": "\ufefffast\ufeff",
                "NOVA_AUDIO_AGENT_WATCH_MODEL": "\ufeffwatch\ufeff",
                "TAVILY_API_KEY": "\ufeffkey\ufeff",
            },
        },
        {
            "id": "qwen_fallback_key",
            "action": "provider",
            "environment": {"NOVA_AUDIO_AGENT_MODEL_API_KEY": "fixture-model-key"},
        },
        {
            "id": "volcengine_fallback_asr_key",
            "action": "provider",
            "environment": {
                "NOVA_AUDIO_AGENT_REALTIME_PROVIDER": "volcengine",
                "ARK_API_KEY": "fixture-ark-key",
                "DOUBAO_BIGMODEL_API_KEY": "fixture-tts-key",
            },
        },
        {
            "id": "qwen_boolean_does_not_strip",
            "action": "load",
            "environment": {"NOVA_AUDIO_AGENT_QWEN_CONTROLLED_GUARD_RECONNECT": " true "},
        },
        {
            "id": "qwen_history_does_not_strip",
            "action": "load",
            "environment": {"NOVA_AUDIO_AGENT_QWEN_GUARD_HISTORY_PAIRS": " 2 "},
        },
        {
            "id": "numeric_inclusive_bounds",
            "action": "load",
            "environment": {
                "NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL": "600",
                "NOVA_AUDIO_AGENT_SUGGESTION_COOLDOWN": "0",
                "NOVA_AUDIO_AGENT_FRESH_WINDOW": "0",
            },
        },
        {
            "id": "numeric_out_of_bounds",
            "action": "load",
            "environment": {"NOVA_AUDIO_AGENT_CODEX_WORKING_INTERVAL": "601"},
        },
        {
            "id": "volcengine_secure_endpoint_rejected",
            "action": "provider",
            "environment": {
                "NOVA_AUDIO_AGENT_REALTIME_PROVIDER": "volcengine",
                "ARK_API_KEY": "fixture-ark-key",
                "DOUBAO_BIGMODEL_API_KEY": "fixture-tts-key",
                "NOVA_AUDIO_AGENT_DOUBAO_ASR_ENDPOINT": "https://invalid.example/asr",
            },
        },
        {
            "id": "desktop_video_absolute",
            "action": "desktop_video",
            "environment": {"NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE": "/fixture/cat-sofa.mp4"},
        },
        {
            "id": "desktop_video_relative_rejected",
            "action": "desktop_video",
            "environment": {"NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE": "fixture/cat-sofa.mp4"},
        },
    ]


@contextmanager
def _environment(values: dict[str, str]):
    with patch.dict(os.environ, values, clear=True):
        yield


def _secret_present(value: object) -> bool:
    if value is None:
        return False
    getter = getattr(value, "get_secret_value", None)
    raw = getter() if callable(getter) else str(value)
    return bool(raw.strip())


def _settings_projection(settings: Settings) -> dict[str, Any]:
    raw = settings.model_dump()
    projected: dict[str, Any] = {}
    for name in sorted(raw):
        if name in RETIRED_FIELDS or name == "executors":
            continue
        value = getattr(settings, name)
        if name in SECRET_FIELDS:
            projected[f"{name}_present"] = _secret_present(value)
        elif isinstance(value, Path):
            projected[name] = str(value)
        else:
            projected[name] = value
    active, _ = _active_executor_names(settings)
    projected["executors"] = list(active)
    projected["proactivity"] = asdict(resolve_proactivity(settings))
    return projected


def _provider_projection(settings: Settings) -> dict[str, Any]:
    if settings.realtime_provider == "qwen":
        url, model, voice, key = settings.require_qwen_realtime()
        return {
            "provider": "qwen",
            "url": url,
            "model": model,
            "voice": voice,
            "key_present": bool(key),
        }
    resolved = asdict(settings.require_volcengine_realtime())
    for field in ("ark_api_key", "asr_api_key", "tts_api_key"):
        resolved[f"{field}_present"] = bool(resolved.pop(field))
    return {"provider": "volcengine", **resolved}


def _run(case: dict[str, Any]) -> dict[str, Any]:
    try:
        if case["action"] == "desktop_video":
            value = case["environment"].get("NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE", "").strip()
            return {
                "ok": Path(value).is_absolute() if value else True,
                "source": "file" if value else "local",
            }
        with _environment(case["environment"]):
            settings = Settings(_env_file=None)
            result: dict[str, Any] = {"ok": True, "settings": _settings_projection(settings)}
            if case["action"] == "provider":
                result["provider"] = _provider_projection(settings)
            return result
    except ValidationError as error:
        return {
            "ok": False,
            "fields": sorted({str(item["loc"][0]).upper() for item in error.errors()}),
        }
    except ConfigurationError:
        return {"ok": False, "fields": []}


def _documents() -> dict[str, dict[str, Any]]:
    cases = _cases()
    return {
        "cases.json": {"schema_version": 1, "cases": cases},
        "expected.json": {
            "schema_version": 1,
            "results": {case["id"]: _run(case) for case in cases},
        },
        "schema.json": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "Nova configuration fixture v1",
            "type": "object",
            "required": ["schema_version"],
            "properties": {"schema_version": {"const": 1}},
            "additionalProperties": True,
        },
    }


def _atomic_write(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as temporary:
        temporary.write(payload)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    args = parser.parse_args()
    produced = _documents()
    if args.command == "export":
        for name, document in produced.items():
            _atomic_write(FIXTURE_ROOT / name, document)
        print(f"exported {len(produced['cases.json']['cases'])} configuration cases")
        return 0
    for name, document in produced.items():
        path = FIXTURE_ROOT / name
        if not path.is_file() or canonical_json(json.loads(path.read_text())) != canonical_json(
            document
        ):
            print(f"configuration fixture drift: {name}", file=sys.stderr)
            return 1
    print(f"Python configuration parity passed: {len(produced['cases.json']['cases'])} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
