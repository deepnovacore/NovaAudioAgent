from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest


SOURCE = Path(__file__).parents[1] / "scripts" / "start_ambient_orb.sh"
PS1_SOURCE = Path(__file__).parents[1] / "scripts" / "start_ambient_orb.ps1"
pytestmark = pytest.mark.real_time


@dataclass(frozen=True)
class LauncherFixture:
    root: Path
    launcher: Path
    python: Path
    npm_log: Path

    def run(
        self,
        *,
        python_override: bool = True,
        **overrides: str,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.pop("CONDA_PREFIX", None)
        env.update(
            {
                "PATH": f"{self.root / 'fake-bin'}:/usr/bin:/bin",
                "NPM_LOG": str(self.npm_log),
            }
        )
        if python_override:
            env["NOVA_AUDIO_AGENT_PYTHON"] = str(self.python)
        else:
            env.pop("NOVA_AUDIO_AGENT_PYTHON", None)
        env.pop("NOVA_AUDIO_AGENT_CODEX_WORKSPACE", None)
        env.update(overrides)
        return subprocess.run(
            [str(self.launcher)],
            cwd=self.root.parent,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def npm_actions(self) -> list[str]:
        if not self.npm_log.exists():
            return []
        return [
            line.removeprefix("npm|").rsplit(" ", 1)[-1]
            for line in self.npm_log.read_text().splitlines()
            if line.startswith("npm|")
        ]

    def start_environment(self) -> dict[str, str]:
        line = next(
            line for line in self.npm_log.read_text().splitlines() if line.startswith("env|")
        )
        _, python, workspace, env_file = line.split("|", 3)
        return {
            "NOVA_AUDIO_AGENT_PYTHON": python,
            "NOVA_AUDIO_AGENT_CODEX_WORKSPACE": workspace,
            "NOVA_AUDIO_AGENT_ENV_FILE": env_file,
        }


def _write_executable(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


def launcher_fixture(
    tmp_path: Path,
    *,
    kernel_name: str,
    env_file: bool,
    electron: bool,
) -> LauncherFixture:
    assert SOURCE.is_file(), "shared launcher script does not exist"
    root = tmp_path / "checkout"
    scripts = root / "scripts"
    desktop = root / "desktop" / "ambient-orb"
    fake_bin = root / "fake-bin"
    scripts.mkdir(parents=True)
    desktop.mkdir(parents=True)
    fake_bin.mkdir()
    launcher = scripts / SOURCE.name
    shutil.copy2(SOURCE, launcher)
    launcher.chmod(0o755)

    (root / ".env.example").write_text("DASHSCOPE_API_KEY=\n")
    if env_file:
        (root / ".env").write_text("DASHSCOPE_API_KEY=test-only\n")

    python = root / "test-python"
    _write_executable(python, "#!/bin/sh\nexit 0\n")
    _write_executable(fake_bin / "uname", f"#!/bin/sh\nprintf '{kernel_name}\\n'\n")
    _write_executable(fake_bin / "codex", "#!/bin/sh\nexit 0\n")
    _write_executable(
        fake_bin / "npm",
        """#!/bin/bash
printf 'npm|%s\n' "$*" >> "$NPM_LOG"
if [[ "${!#}" == "start" ]]; then
    printf 'env|%s|%s|%s\n' \
        "$NOVA_AUDIO_AGENT_PYTHON" \
        "$NOVA_AUDIO_AGENT_CODEX_WORKSPACE" \
        "${NOVA_AUDIO_AGENT_ENV_FILE:-}" >> "$NPM_LOG"
fi
""",
    )
    if electron:
        _write_executable(
            desktop / "node_modules" / ".bin" / "electron",
            "#!/bin/sh\nexit 0\n",
        )

    return LauncherFixture(
        root=root,
        launcher=launcher,
        python=python,
        npm_log=root / "npm.log",
    )


@pytest.mark.parametrize("kernel_name", ["Darwin", "Linux"])
def test_first_launch_installs_dependencies_then_starts(tmp_path: Path, kernel_name: str) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=True, electron=False)

    result = fixture.run()

    assert result.returncode == 0, result.stderr
    assert fixture.npm_actions() == ["ci", "start"]
    assert fixture.start_environment() == {
        "NOVA_AUDIO_AGENT_PYTHON": str(fixture.python),
        "NOVA_AUDIO_AGENT_CODEX_WORKSPACE": str(fixture.root),
        "NOVA_AUDIO_AGENT_ENV_FILE": str(fixture.root / ".env"),
    }


@pytest.mark.parametrize("kernel_name", ["Darwin", "Linux"])
def test_later_launch_skips_dependency_install(tmp_path: Path, kernel_name: str) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=True, electron=True)

    result = fixture.run()

    assert result.returncode == 0, result.stderr
    assert fixture.npm_actions() == ["start"]


@pytest.mark.parametrize("kernel_name", ["Darwin", "Linux"])
def test_existing_workspace_override_is_preserved(tmp_path: Path, kernel_name: str) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=True, electron=True)
    workspace = tmp_path / "other-workspace"
    workspace.mkdir()

    result = fixture.run(NOVA_AUDIO_AGENT_CODEX_WORKSPACE=str(workspace))

    assert result.returncode == 0, result.stderr
    start_environment = fixture.start_environment()
    assert start_environment["NOVA_AUDIO_AGENT_CODEX_WORKSPACE"] == str(workspace)
    assert start_environment["NOVA_AUDIO_AGENT_ENV_FILE"] == str(fixture.root / ".env")


@pytest.mark.parametrize("kernel_name", ["Darwin", "Linux"])
def test_unusable_active_conda_falls_back_to_repository_venv(
    tmp_path: Path, kernel_name: str
) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=True, electron=True)
    active_conda = fixture.root / "active-conda"
    _write_executable(active_conda / "bin" / "python", "#!/bin/sh\nexit 1\n")
    repository_python = fixture.root / ".venv" / "bin" / "python"
    _write_executable(repository_python, "#!/bin/sh\nexit 0\n")

    result = fixture.run(
        python_override=False,
        CONDA_PREFIX=str(active_conda),
    )

    assert result.returncode == 0, result.stderr
    assert fixture.start_environment()["NOVA_AUDIO_AGENT_PYTHON"] == str(repository_python)


@pytest.mark.parametrize("kernel_name", ["Darwin", "Linux"])
def test_missing_env_stops_before_npm(tmp_path: Path, kernel_name: str) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=False, electron=False)

    result = fixture.run()

    assert result.returncode != 0
    assert "cp .env.example .env" in result.stderr
    assert fixture.npm_actions() == []


@pytest.mark.parametrize("kernel_name", ["FreeBSD", "Windows_NT", "SunOS"])
def test_unsupported_kernel_fails_before_npm(tmp_path: Path, kernel_name: str) -> None:
    fixture = launcher_fixture(tmp_path, kernel_name=kernel_name, env_file=True, electron=True)

    result = fixture.run()

    assert result.returncode != 0
    assert "macOS" in result.stderr
    assert "Linux" in result.stderr
    assert fixture.npm_actions() == []


def test_ps1_declares_same_env_contract() -> None:
    assert PS1_SOURCE.is_file(), "PowerShell launcher script does not exist"
    text = PS1_SOURCE.read_text(encoding="utf-8")

    for name in (
        "NOVA_AUDIO_AGENT_PYTHON",
        "NOVA_AUDIO_AGENT_CODEX_WORKSPACE",
        "NOVA_AUDIO_AGENT_ENV_FILE",
    ):
        assert f"$env:{name}" in text, f"{name} is not set by the PowerShell launcher"

    assert "Scripts\\python.exe" in text
    assert "CONDA_PREFIX" in text
    assert "conda run" in text
    assert "nova-audio-agent" in text
    assert "nova_audio_agent" in text
    assert "codex" in text
    assert "npm" in text
