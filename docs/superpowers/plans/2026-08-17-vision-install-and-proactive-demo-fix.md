# Vision Installation and Proactive Demo Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented Ambient Orb setup install its required OpenCV extra and make the real-model proactive demo exercise an explicit user-requested notification condition.

**Architecture:** Keep OpenCV optional at the package boundary and repair only the setup paths that actually start camera-backed desktop features. Keep the production Surrogate policy unchanged; correct the demo fixture and protect its semantics with a deterministic runtime-level regression test.

**Tech Stack:** Python 3.11+, asyncio, pytest/pytest-asyncio, uv, Bash, Markdown.

## Global Constraints

- Keep `opencv-python>=4.10,<5` in the optional `vision` extra; do not make it a core dependency.
- Do not loosen `SURROGATE_SYSTEM` or make the proactive acceptance demo non-gating.
- Do not silently disable an explicitly requested local or file-backed camera.
- Preserve the real demo route `Surrogate → FastBrain` and its existing speech/paraphrase/fired-state assertions.
- Keep English and Chinese README instructions equivalent.

---

### Task 1: Make the proactive demo fixture policy-consistent

**Files:**
- Create: `tests/test_demos.py`
- Modify: `src/nova_audio_agent/demos.py:255-286`

**Interfaces:**
- Consumes: `demo_proactive(settings: Settings, writer: DemoWriter) -> DemoResult`, `Runtime`, `ContextView`, `SurrogateOutput`, and `TextDelta`.
- Produces: The same public demo function and result contract, with an explicit trusted-user notification condition and a matching ambient observation.

- [ ] **Step 1: Write the failing runtime-level regression test**

Create `tests/test_demos.py` with a policy-shaped Surrogate that selects only when the trusted-user request explicitly contains both the continued-activity condition and a request to notify. Use a real `Runtime` so the test covers suggestion offering, second-hop FastBrain wake-up, speech recording, and suggestion firing.

```python
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

import nova_audio_agent.demos as demos
from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.context_view import ContextView
from nova_audio_agent.executors.sims import SlowSim
from nova_audio_agent.memory import CONVERSATION_CHANNEL, Memory
from nova_audio_agent.ports import FastBrainDelta, SurrogateOutput, TextDelta
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import CliSpeechSink


class _ExplicitNotificationSurrogate:
    async def watch(self, view: ContextView) -> SurrogateOutput:
        requests = [
            str(item.content.get("text", ""))
            for channel in view.channels
            if channel.name == CONVERSATION_CHANNEL
            for item in channel.recent
            if item.trust == "trusted_user"
        ]
        suggestions = tuple(item for item in view.affordances if item.source == "suggestion")
        explicitly_requested = any(
            "客厅持续有人活动" in request and "提醒我" in request for request in requests
        )
        if not explicitly_requested or not suggestions:
            return SurrogateOutput(speak=False, reason="没有明确的命中即提醒条件")
        return SurrogateOutput(
            speak=True,
            suggestion_id=suggestions[0].ref,
            reason="用户要求的提醒条件已命中",
        )


class _ParaphrasingFastBrain:
    async def call(self, _view: ContextView) -> AsyncIterator[FastBrainDelta]:
        yield TextDelta(text="客厅一直有动静，需要您看一下。")


@pytest.mark.asyncio
async def test_proactive_demo_uses_an_explicit_user_notification_condition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer: list[str] = []
    executor = SlowSim()
    runtime = Runtime(
        clock=RealClock(),
        memory=Memory(policies=(executor.manifest.policy, demos._AMBIENT_POLICY)),
        fastbrain=_ParaphrasingFastBrain(),
        surrogate=_ExplicitNotificationSurrogate(),
        executors={executor.manifest.name: executor},
        sink=CliSpeechSink(writer.append),
    )
    monkeypatch.setattr(demos, "_build", lambda *_args, **_kwargs: runtime)

    result = await demos.demo_proactive(Settings(_env_file=None), writer.append)

    assert result.passed
    assert result.detail == "Surrogate → FastBrain 两跳发言且未逐字复述 suggestion"
```

- [ ] **Step 2: Run the test and verify the current fixture fails**

Run:

```bash
uv run pytest tests/test_demos.py::test_proactive_demo_uses_an_explicit_user_notification_condition -q
```

Expected: FAIL because the current request is `帮我留意一下客厅`, so the fake Surrogate returns `speak=False` and `DemoResult.passed` is false.

- [ ] **Step 3: Make the minimal fixture correction**

In `src/nova_audio_agent/demos.py`, preserve the existing event shape and two-hop assertions but change the three semantic strings:

```python
def _ambient_event() -> HandoffEvent:
    """Demo-only ambient envelope; it is deliberately not a production ingress API."""
    return HandoffEvent(
        channel="ambient",
        delegate_id="demo-ambient",
        origin_ref="conversation:1",
        outcome="ok",
        trust="trusted_system",
        content={"motion": "客厅持续有人活动，已达到用户要求的提醒条件"},
    )
```

Inside `demo_proactive`, use:

```python
content={"text": "如果客厅持续有人活动，就提醒我"},
```

and:

```python
suggestion_text = "客厅持续有人活动，已达到用户要求的提醒条件"
```

- [ ] **Step 4: Run the focused demo test**

Run:

```bash
uv run pytest tests/test_demos.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit the proactive fixture and regression test**

```bash
git add src/nova_audio_agent/demos.py tests/test_demos.py
git commit -m "fix: align proactive demo with notification policy"
```

---

### Task 2: Make camera-dependent setup paths install the vision extra

**Files:**
- Modify: `tests/test_project_files.py:180-190`
- Modify: `scripts/bootstrap_backend.sh:18-23`
- Modify: `README.md:177-188`
- Modify: `README.zh-CN.md:161-173`

**Interfaces:**
- Consumes: the existing `vision` optional dependency from `pyproject.toml` and the Ambient Orb launch command `./scripts/start_ambient_orb_macos.sh`.
- Produces: a Conda bootstrap environment containing OpenCV and bilingual Ambient Orb instructions that install `vision` before launch.

- [ ] **Step 1: Add failing repository-contract tests**

Add these tests after `test_conda_environment_provisions_uv` in `tests/test_project_files.py`:

```python
@pytest.mark.parametrize(
    ("readme", "section_heading", "next_heading"),
    (
        (Path("README.md"), "## 5. macOS Ambient Orb", "## 6. Repository layout"),
        (Path("README.zh-CN.md"), "## 5. macOS Ambient Orb", "## 6. 仓库布局"),
    ),
)
def test_ambient_orb_readme_installs_vision_before_launch(
    readme: Path,
    section_heading: str,
    next_heading: str,
) -> None:
    document = readme.read_text(encoding="utf-8")
    section = document.split(section_heading, 1)[1].split(next_heading, 1)[0]

    assert section.index("uv sync --extra vision --dev") < section.index(
        "./scripts/start_ambient_orb_macos.sh"
    )


def test_conda_backend_bootstrap_installs_vision_extra() -> None:
    bootstrap = Path("scripts/bootstrap_backend.sh").read_text(encoding="utf-8")

    assert "uv sync --locked --extra vision" in bootstrap
```

- [ ] **Step 2: Run the repository tests and verify both contracts fail**

Run:

```bash
uv run pytest tests/test_project_files.py::test_ambient_orb_readme_installs_vision_before_launch tests/test_project_files.py::test_conda_backend_bootstrap_installs_vision_extra -q
```

Expected: three failures: one for each README parameter and one for the bootstrap script.

- [ ] **Step 3: Install the vision extra in the Conda bootstrap**

Change the final sync command in `scripts/bootstrap_backend.sh` to:

```bash
uv sync --locked --extra vision
```

Keep `UV_PROJECT_ENVIRONMENT="$CONDA_PREFIX"`, the locked sync, and the existing Conda create/update behavior unchanged.

- [ ] **Step 4: Put the required install command directly before Ambient Orb launch**

Change the English README block to:

```bash
uv sync --extra vision --dev
./scripts/start_ambient_orb_macos.sh
```

Add one sentence immediately before or after it stating that both the local-camera default and `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` playback require the `vision` extra.

Make the equivalent change in `README.zh-CN.md`, using the same commands and explaining that默认本地摄像头和 `NOVA_AUDIO_AGENT_DESKTOP_VIDEO_FILE` 视频回放均依赖 `vision` extra.

- [ ] **Step 5: Run the focused repository tests**

Run:

```bash
uv run pytest tests/test_project_files.py::test_ambient_orb_readme_installs_vision_before_launch tests/test_project_files.py::test_conda_backend_bootstrap_installs_vision_extra -q
```

Expected: all three parameterized cases PASS.

- [ ] **Step 6: Commit the setup-path repair**

```bash
git add README.md README.zh-CN.md scripts/bootstrap_backend.sh tests/test_project_files.py
git commit -m "fix: install vision extra for Ambient Orb"
```

---

### Task 3: Verify the complete repair

**Files:**
- Verify only; no new files.

**Interfaces:**
- Consumes: the corrected proactive fixture and camera setup contracts from Tasks 1 and 2.
- Produces: evidence that deterministic tests, lint, package resolution, and the configured live-model demo all pass.

- [ ] **Step 1: Run formatting and static checks on changed Python files**

```bash
uv run ruff check src/nova_audio_agent/demos.py tests/test_demos.py tests/test_project_files.py
uv run ruff format --check src/nova_audio_agent/demos.py tests/test_demos.py tests/test_project_files.py
```

Expected: both commands exit 0 with no findings.

- [ ] **Step 2: Verify the vision dependency resolves from the lockfile**

```bash
uv sync --locked --extra vision --dev
uv run python -c 'import cv2; print(cv2.__version__)'
```

Expected: sync exits 0 and Python prints an OpenCV 4.x version.

- [ ] **Step 3: Run the full deterministic test suite**

```bash
uv run pytest -q
```

Expected: all tests pass.

- [ ] **Step 4: Run the real-model proactive acceptance demo**

```bash
uv run nova-audio-agent demo proactive
```

Expected output includes:

```text
[proactive demo-ambient ok]
[通过] Surrogate → FastBrain 两跳发言且未逐字复述 suggestion
```

- [ ] **Step 5: Inspect the final diff and working tree**

```bash
git diff --check
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; only the ignored implementation-plan file may remain outside the three committed changes (design, proactive fix, setup fix).
