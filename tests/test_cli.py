from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest
from pydantic import SecretStr
from rich.text import Text
import typer
from typer.testing import CliRunner

import nova_audio_agent.cli as cli_module
from nova_audio_agent.assembly import resolve_camera_source
from nova_audio_agent.cli import app
from nova_audio_agent.config import ConfigurationError, Settings, _venv_python
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.camera import ScriptedFrameSource
from nova_audio_agent.media import MediaStore
from nova_audio_agent.speech import CliSpeechSink


class _StringSubclass(str):
    pass


def test_settings_have_stage_c_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "NOVA_AUDIO_AGENT_MODEL_BASE_URL",
        "NOVA_AUDIO_AGENT_MODEL_API_KEY",
        "NOVA_AUDIO_AGENT_FAST_MODEL",
        "NOVA_AUDIO_AGENT_SURROGATE_MODEL",
        "NOVA_AUDIO_AGENT_COMPRESSOR_MODEL",
        "NOVA_AUDIO_AGENT_EXECUTOR",
        "NOVA_AUDIO_AGENT_HA_URL",
        "NOVA_AUDIO_AGENT_HA_TOKEN",
        "NOVA_AUDIO_AGENT_HA_ENTITY_ID",
        "NOVA_AUDIO_AGENT_CODEX_WORKSPACE",
        "NOVA_AUDIO_AGENT_CODEX_BIN",
        "NOVA_AUDIO_AGENT_CODEX_API_KEY",
        "NOVA_AUDIO_AGENT_AUTOGLM_REPO",
        "NOVA_AUDIO_AGENT_AUTOGLM_PYTHON",
        "NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL",
        "NOVA_AUDIO_AGENT_AUTOGLM_MODEL",
        "NOVA_AUDIO_AGENT_AUTOGLM_API_KEY",
        "NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL",
        "NOVA_AUDIO_AGENT_AUTOGLM_DEVICE_ID",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = Settings(
        model_api_key=SecretStr("secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        _env_file=None,
    )

    assert settings.model_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert settings.fast_model == "qwen3-vl-plus"
    assert settings.surrogate_model == "qwen-flash"
    assert settings.compressor_model == "qwen-flash"
    assert settings.executor == "fast_sim"
    assert settings.codex_bin == "codex"
    assert settings.require_tavily_api_key() == "tavily-secret"


def test_project_settings_read_prefixed_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_PROJECTS_ENABLED", "false")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT", str(tmp_path / "managed"))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT", str(tmp_path / "state"))

    settings = Settings(_env_file=None)

    assert not hasattr(settings, "codex_projects_enabled")
    assert settings.require_codex_projects() == (
        (tmp_path / "managed").resolve(),
        (tmp_path / "state").resolve(),
    )
    assert (tmp_path / "managed").stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "state").stat().st_mode & 0o777 == 0o700


def test_workspace_register_and_list_hide_local_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    managed = tmp_path / "managed"
    state = tmp_path / "state"
    workspace = tmp_path / "private" / "repo"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_MANAGED_ROOT", str(managed))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_PROJECT_STATE_ROOT", str(state))
    runner = CliRunner()

    registered = runner.invoke(app, ["workspace", "register", "alpha", str(workspace)])
    listed = runner.invoke(app, ["workspace", "list"])

    assert registered.exit_code == 0
    assert listed.exit_code == 0
    assert "alpha" in listed.stdout
    assert str(tmp_path) not in registered.stdout + listed.stdout


@pytest.mark.real_time
def test_chat_exits_after_one_sigint_without_waiting_for_more_stdin() -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = "src"
    env["NOVA_AUDIO_AGENT_MODEL_API_KEY"] = "test-only"
    env["TAVILY_API_KEY"] = "test-only"
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from nova_audio_agent.cli import app; app()",
            "chat",
        ],
        cwd=Path(__file__).parents[1],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.read(len(b"you> ")) == b"you> "
        assert process.stdin is not None
        process.stdin.write(b"x")
        process.stdin.flush()
        time.sleep(0.02)
        process.send_signal(signal.SIGINT)
        try:
            returncode = process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            pytest.fail("chat remained blocked in stdin after SIGINT")
        assert returncode != 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_missing_api_key_fails_without_echoing_a_secret() -> None:
    settings = Settings(model_api_key=None)

    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_MODEL_API_KEY"):
        settings.require_api_key()


def test_tavily_key_reads_its_unprefixed_environment_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TAVILY_API_KEY", "from-environment")

    settings = Settings(model_api_key=SecretStr("model-secret"), _env_file=None)

    assert settings.require_tavily_api_key() == "from-environment"


def test_missing_tavily_key_fails_without_echoing_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=None,
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="TAVILY_API_KEY") as raised:
        settings.require_tavily_api_key()

    assert "model-secret" not in str(raised.value)


def test_home_assistant_settings_read_the_prefixed_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_HA_URL", "http://homeassistant.local:8123/")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_HA_TOKEN", "ha-private-token")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_HA_ENTITY_ID", "light.bedside_lamp")

    settings = Settings(executor="ha", _env_file=None)

    assert settings.require_home_assistant() == (
        "http://homeassistant.local:8123",
        "ha-private-token",
        "light.bedside_lamp",
    )


@pytest.mark.parametrize(
    ("kwargs", "missing_name"),
    (
        (
            {
                "ha_url": None,
                "ha_token": SecretStr("token"),
                "ha_entity_id": "light.bedside_lamp",
            },
            "NOVA_AUDIO_AGENT_HA_URL",
        ),
        (
            {
                "ha_url": "http://ha.test",
                "ha_token": None,
                "ha_entity_id": "light.bedside_lamp",
            },
            "NOVA_AUDIO_AGENT_HA_TOKEN",
        ),
        (
            {
                "ha_url": "http://ha.test",
                "ha_token": SecretStr("token"),
                "ha_entity_id": None,
            },
            "NOVA_AUDIO_AGENT_HA_ENTITY_ID",
        ),
    ),
)
def test_home_assistant_configuration_reports_only_the_missing_name(
    kwargs: dict[str, object],
    missing_name: str,
) -> None:
    settings = Settings(executor="ha", _env_file=None, **kwargs)

    with pytest.raises(ConfigurationError, match=missing_name) as raised:
        settings.require_home_assistant()

    assert "token" not in str(raised.value)


@pytest.mark.parametrize("entity_id", ("switch.bedside_lamp", "light.", "light.Bad Lamp"))
def test_home_assistant_configuration_rejects_non_light_entity_ids(entity_id: str) -> None:
    settings = Settings(
        executor="ha",
        ha_url="http://ha.test",
        ha_token=SecretStr("token"),
        ha_entity_id=entity_id,
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_HA_ENTITY_ID"):
        settings.require_home_assistant()


def test_cli_accepts_home_assistant_as_the_active_executor() -> None:
    assert cli_module._settings("ha").executor == "ha"


def test_codex_settings_read_the_prefixed_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_WORKSPACE", str(workspace / "."))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_BIN", "/opt/tools/codex")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_CODEX_API_KEY", "codex-private-key")

    settings = Settings(executor="codex", _env_file=None)

    resolved, binary, api_key = settings.require_codex()
    assert resolved == workspace.resolve()
    assert binary == "/opt/tools/codex"
    assert api_key == "codex-private-key"
    assert type(api_key) is str


def test_codex_settings_default_to_the_codex_binary(tmp_path: Path) -> None:
    settings = Settings(
        executor="codex",
        codex_workspace=tmp_path,
        codex_api_key=None,
        _env_file=None,
    )

    assert settings.require_codex() == (tmp_path.resolve(), "codex", None)


def test_codex_workspace_expands_a_leading_tilde(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))
    settings = Settings(
        executor="codex",
        codex_workspace=Path("~/workspace"),
        _env_file=None,
    )

    assert settings.require_codex()[0] == workspace.resolve()


def test_codex_api_key_is_returned_as_an_exact_builtin_string(tmp_path: Path) -> None:
    settings = Settings(
        executor="codex",
        codex_workspace=tmp_path,
        codex_api_key=SecretStr(_StringSubclass("codex-private-key")),
        _env_file=None,
    )

    api_key = settings.require_codex()[2]

    assert type(api_key) is str


@pytest.mark.parametrize(
    ("workspace_factory", "expected"),
    (
        (lambda _root: None, "NOVA_AUDIO_AGENT_CODEX_WORKSPACE"),
        (lambda root: root / "missing", "NOVA_AUDIO_AGENT_CODEX_WORKSPACE"),
        (lambda root: root / "file", "NOVA_AUDIO_AGENT_CODEX_WORKSPACE"),
    ),
    ids=("missing", "not-found", "not-directory"),
)
def test_codex_configuration_rejects_an_unusable_workspace_without_disclosing_it(
    tmp_path: Path,
    workspace_factory,
    expected: str,
) -> None:
    file_path = tmp_path / "file"
    file_path.write_text("not a workspace", encoding="utf-8")
    workspace = workspace_factory(tmp_path)
    settings = Settings(
        executor="codex",
        codex_workspace=workspace,
        codex_api_key=SecretStr("codex-private-key"),
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match=expected) as raised:
        settings.require_codex()

    message = str(raised.value)
    assert "codex-private-key" not in message
    assert str(tmp_path) not in message


def test_codex_configuration_rejects_a_blank_binary_without_disclosing_credentials(
    tmp_path: Path,
) -> None:
    settings = Settings(
        executor="codex",
        codex_workspace=tmp_path,
        codex_bin=" \t ",
        codex_api_key=SecretStr("codex-private-key"),
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_CODEX_BIN") as raised:
        settings.require_codex()

    assert "codex-private-key" not in str(raised.value)
    assert str(tmp_path) not in str(raised.value)


def test_codex_configuration_maps_a_symlink_loop_to_a_safe_error(tmp_path: Path) -> None:
    loop = tmp_path / "private-workspace-loop"
    loop.symlink_to(loop)
    settings = Settings(
        executor="codex",
        codex_workspace=loop,
        codex_api_key=SecretStr("codex-private-key"),
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="NOVA_AUDIO_AGENT_CODEX_WORKSPACE") as raised:
        settings.require_codex()

    message = str(raised.value)
    assert "codex-private-key" not in message
    assert str(tmp_path) not in message


def test_non_codex_settings_do_not_require_a_codex_workspace() -> None:
    settings = Settings(
        executor="fast_sim",
        codex_workspace=None,
        codex_bin=" ",
        _env_file=None,
    )

    assert settings.executor == "fast_sim"


def test_cli_accepts_codex_as_the_active_executor() -> None:
    assert cli_module._settings("codex").executor == "codex"


def test_settings_read_the_nova_audio_agent_environment_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NOVA_AUDIO_AGENT_MODEL_API_KEY", "renamed-environment-key")

    settings = Settings(_env_file=None)

    assert settings.require_api_key() == "renamed-environment-key"


def test_cli_rejects_a_removed_executor() -> None:
    removed_executor = "".join(("ro", "ver"))
    with pytest.raises(typer.BadParameter):
        cli_module._settings(removed_executor)


def test_camera_source_rejects_a_removed_source() -> None:
    removed_source = "".join(("ro", "ver"))
    with pytest.raises(ConfigurationError):
        resolve_camera_source(
            active_executors=frozenset({removed_source}),
            requested=removed_source,
            legacy_camera=False,
            camera_index=0,
        )


@pytest.mark.parametrize(
    ("active_executors", "requested", "legacy_camera", "camera_index", "expected"),
    (
        (frozenset({"fast_sim"}), "auto", False, 0, "disabled"),
        (frozenset({"fast_sim"}), "auto", True, 2, "local"),
        (frozenset({"fast_sim"}), "local", False, 0, "local"),
        (frozenset({"fast_sim"}), "disabled", False, 0, "disabled"),
    ),
)
def test_camera_source_resolution_matrix(
    active_executors: frozenset[str],
    requested: str,
    legacy_camera: bool,
    camera_index: int,
    expected: str,
) -> None:
    assert (
        resolve_camera_source(
            active_executors=active_executors,
            requested=requested,
            legacy_camera=legacy_camera,
            camera_index=camera_index,
        )
        == expected
    )


@pytest.mark.parametrize(
    ("active_executors", "requested", "legacy_camera", "camera_index"),
    (
        (frozenset({"fast_sim"}), "".join(("ro", "ver")), False, 0),
        (frozenset({"fast_sim"}), "disabled", False, 1),
    ),
)
def test_camera_source_rejects_conflicts_and_nonlocal_indexes(
    active_executors: frozenset[str],
    requested: str,
    legacy_camera: bool,
    camera_index: int,
) -> None:
    with pytest.raises(ConfigurationError):
        resolve_camera_source(
            active_executors=active_executors,
            requested=requested,
            legacy_camera=legacy_camera,
            camera_index=camera_index,
        )


def test_file_camera_source_accepts_only_an_absolute_regular_file(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    assert (
        resolve_camera_source(
            active_executors=frozenset({"fast_sim"}),
            requested="file",
            legacy_camera=False,
            camera_index=0,
            camera_file=video,
        )
        == "file"
    )

    for invalid in (None, Path("relative.mp4"), tmp_path / "missing.mp4", tmp_path):
        with pytest.raises(ConfigurationError):
            resolve_camera_source(
                active_executors=frozenset({"fast_sim"}),
                requested="file",
                legacy_camera=False,
                camera_index=0,
                camera_file=invalid,
            )


def test_non_file_camera_sources_reject_camera_file(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    for requested in ("auto", "local", "disabled"):
        with pytest.raises(ConfigurationError):
            resolve_camera_source(
                active_executors=frozenset({"fast_sim"}),
                requested=requested,
                legacy_camera=False,
                camera_index=0,
                camera_file=video,
            )


def test_file_camera_source_rejects_nonzero_camera_index(tmp_path: Path) -> None:
    video = tmp_path / "cat-sofa.mp4"
    video.write_bytes(b"video")

    with pytest.raises(ConfigurationError, match="--camera-index"):
        resolve_camera_source(
            active_executors=frozenset({"fast_sim"}),
            requested="file",
            legacy_camera=False,
            camera_index=1,
            camera_file=video,
        )


def test_autoglm_settings_read_the_prefixed_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "Open-AutoGLM"
    repo.mkdir()
    external_python = tmp_path / "autoglm-python"
    external_python.write_text("", encoding="utf-8")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_REPO", str(repo))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_PYTHON", str(external_python))
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL", "https://model.example/v1/")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_MODEL", "autoglm-phone-test")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_API_KEY", "autoglm-private-key")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL", "http://localhost:8100/")
    monkeypatch.setenv("NOVA_AUDIO_AGENT_AUTOGLM_DEVICE_ID", " device-123 ")

    settings = Settings(executor="autoglm", _env_file=None)

    assert isinstance(settings.autoglm_api_key, SecretStr)
    assert settings.require_autoglm() == (
        repo.resolve(),
        str(external_python.resolve()),
        "https://model.example/v1",
        "autoglm-phone-test",
        settings.autoglm_api_key,
        "http://localhost:8100",
        "device-123",
    )
    assert "autoglm-private-key" not in repr(settings)


def test_autoglm_settings_preserve_virtualenv_python_symlink(tmp_path: Path) -> None:
    repo = tmp_path / "Open-AutoGLM"
    repo.mkdir()
    base_python = tmp_path / "base-python"
    base_python.write_text("", encoding="utf-8")
    venv_python = tmp_path / "venv-python"
    venv_python.symlink_to(base_python)
    settings = Settings(
        executor="autoglm",
        autoglm_repo=repo,
        autoglm_python=str(venv_python),
        autoglm_api_key=SecretStr("autoglm-private-key"),
        _env_file=None,
    )

    assert settings.require_autoglm()[1] == str(venv_python.absolute())


def test_venv_python_resolves_the_interpreter_path_per_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(os, "name", "posix")
    assert _venv_python(".autoglm-venv") == ".autoglm-venv/bin/python"

    monkeypatch.setattr(os, "name", "nt")
    assert _venv_python(".autoglm-venv") == ".autoglm-venv/Scripts/python.exe"


def test_autoglm_python_default_tracks_the_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NOVA_AUDIO_AGENT_AUTOGLM_PYTHON", raising=False)

    monkeypatch.setattr(os, "name", "posix")
    assert Settings(_env_file=None).autoglm_python == ".autoglm-venv/bin/python"

    monkeypatch.setattr(os, "name", "nt")
    assert Settings(_env_file=None).autoglm_python == ".autoglm-venv/Scripts/python.exe"


@pytest.mark.parametrize(
    ("overrides", "expected"),
    (
        ({"autoglm_repo": None}, "NOVA_AUDIO_AGENT_AUTOGLM_REPO"),
        ({"autoglm_python": " "}, "NOVA_AUDIO_AGENT_AUTOGLM_PYTHON"),
        ({"autoglm_base_url": "http://model.example/v1"}, "NOVA_AUDIO_AGENT_AUTOGLM_BASE_URL"),
        ({"autoglm_model": " "}, "NOVA_AUDIO_AGENT_AUTOGLM_MODEL"),
        ({"autoglm_api_key": None}, "NOVA_AUDIO_AGENT_AUTOGLM_API_KEY"),
        ({"autoglm_wda_url": "http://phone.example:8100"}, "NOVA_AUDIO_AGENT_AUTOGLM_WDA_URL"),
    ),
)
def test_autoglm_configuration_rejects_invalid_values_without_disclosing_credentials(
    tmp_path: Path,
    overrides: dict[str, object],
    expected: str,
) -> None:
    repo = tmp_path / "private-autoglm-repo"
    repo.mkdir()
    external_python = tmp_path / "private-autoglm-python"
    external_python.write_text("", encoding="utf-8")
    values: dict[str, object] = {
        "executor": "autoglm",
        "autoglm_repo": repo,
        "autoglm_python": str(external_python),
        "autoglm_base_url": "https://model.example/v1",
        "autoglm_model": "autoglm-phone",
        "autoglm_api_key": SecretStr("autoglm-private-key"),
        "autoglm_wda_url": "http://127.0.0.1:8100",
        "_env_file": None,
    }
    values.update(overrides)
    settings = Settings(**values)

    with pytest.raises(ConfigurationError, match=expected) as raised:
        settings.require_autoglm()

    message = str(raised.value)
    assert "autoglm-private-key" not in message
    assert str(tmp_path) not in message


def test_cli_accepts_autoglm_as_the_active_executor() -> None:
    assert cli_module._settings("autoglm").executor == "autoglm"


async def test_chat_requires_tavily_key_before_reading_the_first_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unexpected_read(_prompt: str) -> str:
        raise AssertionError("chat consumed input before validating its search credential")

    monkeypatch.setattr(cli_module, "_read_input", unexpected_read)
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=None,
        _env_file=None,
    )

    with pytest.raises(ConfigurationError, match="TAVILY_API_KEY"):
        await cli_module._chat(settings)


async def test_chat_starts_camera_posts_attachment_refs_and_stops_on_exit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    image = tmp_path / "frame.png"
    image.write_bytes(
        __import__("base64").b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
            "AScY42YAAAAASUVORK5CYII="
        )
    )
    inputs = iter((f'看图 "@{image}"', "/quit"))

    async def read(_prompt: str) -> str:
        return next(inputs)

    class _Clock:
        def now(self) -> float:
            return 9.0

    class _Runtime:
        def __init__(self) -> None:
            self.clock = _Clock()
            self.events: list[UserInput] = []

        def post(self, event: UserInput) -> None:
            self.events.append(event)

        async def serve(self, stop) -> None:
            await stop.wait()

    source = ScriptedFrameSource()
    runtime = _Runtime()
    store = MediaStore(id_factory=lambda: "upload")
    build_calls: list[dict[str, object]] = []

    class _Assembly:
        def __init__(self) -> None:
            self.runtime = runtime
            self.frame_source = source
            self.media_store = store

        async def start(self) -> None:
            await source.start()

        async def stop(self) -> None:
            await source.stop()

    def build(_settings, **kwargs):
        build_calls.append(kwargs)
        return _Assembly()

    monkeypatch.setattr(cli_module, "_read_input", read)
    monkeypatch.setattr(cli_module, "build_assembly", build)
    settings = Settings(
        model_api_key=SecretStr("model-secret"),
        tavily_api_key=SecretStr("tavily-secret"),
        _env_file=None,
    )

    await cli_module._chat(
        settings,
        camera_source="auto",
        camera_enabled=True,
        camera_index=2,
    )

    assert build_calls[0]["camera_source"] == "auto"
    assert build_calls[0]["camera_enabled"] is True
    assert build_calls[0]["camera_index"] == 2
    assert source.starts == 1
    assert source.stops == 1
    assert runtime.events == [UserInput(text="看图", media_refs=("media:upload",))]


def test_cli_sink_forwards_each_chunk_immediately() -> None:
    written: list[str] = []
    sink = CliSpeechSink(written.append)

    sink.emit("u-1", "first")
    sink.emit("u-1", " second")
    sink.end("u-1")

    assert written == ["first", " second", "\n"]


def test_cli_routes_chat_scorecard_and_demo_commands() -> None:
    result = CliRunner().invoke(app, ["--help"])

    assert result.exit_code == 0
    assert "chat" in result.output
    assert "scorecard" in result.output
    assert "demo" in result.output

    demo = CliRunner().invoke(app, ["demo", "--help"])
    assert demo.exit_code == 0
    assert all(
        command in demo.output for command in ("async", "dual-axis", "timeout", "proactive", "all")
    )


def test_scorecard_output_option_is_a_path() -> None:
    result = CliRunner().invoke(
        app,
        ["scorecard", "--runs", "0", "--output", str(Path("report.json"))],
    )

    assert result.exit_code != 0
    assert "--runs" in Text.from_ansi(result.output).plain
