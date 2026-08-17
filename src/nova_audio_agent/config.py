"""Environment-only assembly settings."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigurationError(RuntimeError):
    """A safe startup error that never contains credential values."""


def _safe_project_root(value: Path, variable: str) -> Path:
    try:
        expanded = value.expanduser().absolute()
        if expanded.is_symlink() or (expanded.exists() and not expanded.is_dir()):
            raise OSError
        resolved = expanded.resolve(strict=False)
        if expanded.exists() and resolved != expanded:
            raise OSError
    except (OSError, RuntimeError):
        raise ConfigurationError(f"{variable} 必须是安全的目录") from None
    return resolved


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NOVA_AUDIO_AGENT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    model_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model_api_key: SecretStr | None = None
    fast_model: str = "qwen3-vl-plus"
    watch_model: str | None = None
    surrogate_model: str = "qwen-flash"
    compressor_model: str = "qwen-flash"
    qwen_realtime_url: str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    qwen_realtime_model: str = "qwen-audio-3.0-realtime-plus"
    qwen_realtime_voice: str = "longanqian"
    qwen_controlled_guard_reconnect: bool = False
    qwen_guard_history_recovery: Literal["none", "packed"] = "none"
    qwen_guard_history_pairs: Literal[1, 2, 4] = 4
    dashscope_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="DASHSCOPE_API_KEY",
    )
    executor: Literal["fast_sim", "slow_sim", "ha", "codex", "autoglm"] = "fast_sim"
    executors: str = ""
    ha_url: str | None = None
    ha_token: SecretStr | None = None
    ha_entity_id: str | None = None
    codex_workspace: Path | None = None
    codex_bin: str = "codex"
    codex_api_key: SecretStr | None = None
    codex_prewarm: bool = True
    codex_projects_enabled: bool = False
    codex_managed_root: Path = Path("~/NovaWorkspaces")
    codex_project_state_root: Path = Path("~/.nova-audio-agent")
    autoglm_repo: Path | None = Path("thirdparty/Open-AutoGLM")
    autoglm_python: str = ".autoglm-venv/bin/python"
    autoglm_base_url: str = "https://open.bigmodel.cn/api/paas/v4"
    autoglm_model: str = "autoglm-phone"
    autoglm_api_key: SecretStr | None = None
    autoglm_wda_url: str = "http://127.0.0.1:8100"
    autoglm_device_id: str | None = None
    tavily_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="TAVILY_API_KEY",
    )

    @field_validator("qwen_guard_history_pairs", mode="before")
    @classmethod
    def _parse_qwen_guard_history_pairs(cls, value: object) -> object:
        if type(value) is str and value in {"1", "2", "4"}:
            return int(value)
        return value

    def require_api_key(self) -> str:
        if self.model_api_key is None or not self.model_api_key.get_secret_value():
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_MODEL_API_KEY")
        return self.model_api_key.get_secret_value()

    def require_tavily_api_key(self) -> str:
        if self.tavily_api_key is None or not self.tavily_api_key.get_secret_value():
            raise ConfigurationError("缺少 TAVILY_API_KEY")
        return self.tavily_api_key.get_secret_value()

    def require_qwen_realtime(self) -> tuple[str, str, str, str]:
        url = self.qwen_realtime_url.strip()
        model = self.qwen_realtime_model.strip()
        voice = self.qwen_realtime_voice.strip()
        if not url.startswith("wss://"):
            raise ConfigurationError("NOVA_AUDIO_AGENT_QWEN_REALTIME_URL 必须使用 wss://")
        if not model:
            raise ConfigurationError("NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL 不能为空")
        if not voice:
            raise ConfigurationError("NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE 不能为空")
        realtime_key = (
            self.dashscope_api_key.get_secret_value() if self.dashscope_api_key is not None else ""
        ).strip()
        model_key = (
            self.model_api_key.get_secret_value() if self.model_api_key is not None else ""
        ).strip()
        api_key = realtime_key or model_key
        if not api_key:
            raise ConfigurationError("缺少 DASHSCOPE_API_KEY 或 NOVA_AUDIO_AGENT_MODEL_API_KEY")
        return url, model, voice, api_key

    def require_home_assistant(self) -> tuple[str, str, str]:
        if self.ha_url is None or not self.ha_url.strip():
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_HA_URL")
        if self.ha_token is None or not self.ha_token.get_secret_value():
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_HA_TOKEN")
        if self.ha_entity_id is None or not self.ha_entity_id.strip():
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_HA_ENTITY_ID")
        entity_id = self.ha_entity_id.strip()
        if re.fullmatch(r"light\.[a-z0-9_]+", entity_id) is None:
            raise ConfigurationError("NOVA_AUDIO_AGENT_HA_ENTITY_ID 必须是 light.<name>")
        return (
            self.ha_url.strip().rstrip("/"),
            self.ha_token.get_secret_value(),
            entity_id,
        )

    def require_codex(self) -> tuple[Path, str, str | None]:
        workspace = self.codex_workspace
        if workspace is None:
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_CODEX_WORKSPACE")
        try:
            resolved = workspace.resolve()
            usable = resolved.is_dir()
        except (OSError, RuntimeError):
            usable = False
        if not usable:
            raise ConfigurationError("NOVA_AUDIO_AGENT_CODEX_WORKSPACE 必须是已存在的目录")
        binary = self.codex_bin.strip()
        if not binary:
            raise ConfigurationError("NOVA_AUDIO_AGENT_CODEX_BIN 不能为空")
        api_key = (
            str(self.codex_api_key.get_secret_value()) if self.codex_api_key is not None else None
        )
        return resolved, binary, api_key or None

    def require_codex_projects(self) -> tuple[Path, Path]:
        return (
            _safe_project_root(
                self.codex_managed_root,
                "NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT",
            ),
            _safe_project_root(
                self.codex_project_state_root,
                "NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT",
            ),
        )

    def require_autoglm(
        self,
    ) -> tuple[Path, str, str, str, SecretStr, str, str | None]:
        repo = self.autoglm_repo
        if repo is None:
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_AUTOGLM_REPO")
        try:
            resolved_repo = repo.resolve()
            repo_usable = resolved_repo.is_dir()
        except (OSError, RuntimeError):
            repo_usable = False
        if not repo_usable:
            raise ConfigurationError("NOVA_AUDIO_AGENT_AUTOGLM_REPO 必须是已存在的目录")

        python_value = self.autoglm_python.strip()
        try:
            configured_python = Path(python_value).absolute()
            python_usable = bool(python_value) and configured_python.resolve().is_file()
        except (OSError, RuntimeError):
            python_usable = False
        if not python_usable:
            raise ConfigurationError("NOVA_AUDIO_AGENT_AUTOGLM_PYTHON 必须是已存在的文件")

        base_url = self.autoglm_base_url.strip().rstrip("/")
        try:
            parsed_model_url = urlsplit(base_url)
        except ValueError:
            parsed_model_url = None
        if (
            parsed_model_url is None
            or parsed_model_url.scheme != "https"
            or parsed_model_url.hostname is None
            or parsed_model_url.username is not None
            or parsed_model_url.password is not None
            or parsed_model_url.query
            or parsed_model_url.fragment
        ):
            raise ConfigurationError("NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL 必须是安全的 https:// 地址")

        model = self.autoglm_model.strip()
        if not model:
            raise ConfigurationError("NOVA_AUDIO_AGENT_AUTOGLM_MODEL 不能为空")
        api_key = self.autoglm_api_key
        if api_key is None or not api_key.get_secret_value().strip():
            raise ConfigurationError("缺少 NOVA_AUDIO_AGENT_AUTOGLM_API_KEY")

        wda_url = self.autoglm_wda_url.strip()
        try:
            parsed_wda_url = urlsplit(wda_url)
            wda_port = parsed_wda_url.port
        except ValueError:
            parsed_wda_url = None
            wda_port = None
        if (
            parsed_wda_url is None
            or parsed_wda_url.scheme != "http"
            or parsed_wda_url.hostname not in {"127.0.0.1", "localhost"}
            or wda_port != 8100
            or parsed_wda_url.username is not None
            or parsed_wda_url.password is not None
            or parsed_wda_url.path not in {"", "/"}
            or parsed_wda_url.query
            or parsed_wda_url.fragment
        ):
            raise ConfigurationError(
                "NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL 必须是 http://127.0.0.1:8100 或 http://localhost:8100"
            )
        normalized_wda_url = f"http://{parsed_wda_url.hostname}:8100"
        device_id = (self.autoglm_device_id or "").strip() or None
        return (
            resolved_repo,
            str(configured_python),
            base_url,
            model,
            api_key,
            normalized_wda_url,
            device_id,
        )
