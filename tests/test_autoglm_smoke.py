from __future__ import annotations

import io
from pathlib import Path
from types import SimpleNamespace

import pytest

from nova_audio_agent.executors.autoglm import WdaScreenshot
from nova_audio_agent.executors.autoglm_protocol import AutoGlmWorkerResult
from nova_audio_agent.media import MediaStore
from scripts import smoke_autoglm_ios


_ROOT = Path(__file__).parents[1]


class _Settings:
    def __init__(self, *, key: str = "autoglm-test-secret") -> None:
        self.key = key
        self.calls = 0

    def require_autoglm(self) -> tuple[Path, str, str, str, object, str, str | None]:
        self.calls += 1
        return (
            Path("/repo/Open-AutoGLM"),
            "/isolated/autoglm-python",
            "https://model.example/v4",
            "autoglm-phone",
            SimpleNamespace(get_secret_value=lambda: self.key),
            "http://127.0.0.1:8100",
            "device-1",
        )


class _Wda:
    def __init__(
        self,
        bundle_ids: tuple[str, ...] = ("com.apple.mobilesafari", "com.apple.mobilesafari"),
    ) -> None:
        self.bundle_ids = iter(bundle_ids)

    async def screenshot(self) -> WdaScreenshot:
        return WdaScreenshot(
            payload=b"private pixels",
            media_type="image/png",
            width=20,
            height=10,
        )

    async def active_bundle_id(self) -> str:
        return next(self.bundle_ids)


class _Worker:
    def __init__(self, result: AutoGlmWorkerResult | None = None) -> None:
        self.queries: list[str] = []
        self.result = result or AutoGlmWorkerResult(
            outcome="completed",
            code="completed",
            effect_verification="not_performed",
            events=(
                {"type": "status", "state": "started"},
                {"type": "action", "kind": "tap"},
            ),
        )

    async def run_browse(self, query: str, *, deadline: object) -> AutoGlmWorkerResult:
        self.queries.append(query)
        return self.result


def _dependencies(worker: _Worker) -> dict[str, object]:
    ids = iter(("smoke-0", "smoke-1"))
    return {
        "repo_importer": lambda _python, _repo: True,
        "device_visible": lambda _device_id: True,
        "wda_status": lambda _url: True,
        "wda_factory": lambda _url: _Wda(),
        "worker_factory": lambda *_args: worker,
        "media_store_factory": lambda: MediaStore(id_factory=lambda: next(ids)),
    }


@pytest.mark.asyncio
async def test_default_smoke_is_preflight_only_and_hides_secrets_pixels_and_thinking() -> None:
    settings = _Settings()
    worker = _Worker()
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=False,
        query=None,
        settings=settings,
        emit=output.append,
        **_dependencies(worker),
    )

    assert result == 0
    assert settings.calls == 1
    assert worker.queries == []
    assert len(output) == 1
    assert output[0] == (
        '{"mode":"preflight","repo_imported":true,"iphone_visible":true,'
        '"wda_status":true,"model_configured":true,"screenshot":{"media_ref":"media:smoke-0",'
        '"digest":"c7dab3a61c3f17cc936999c73055f622ac00b9d850f1bb4bd7e00daae67a9137",'
        '"media_type":"image/png","width":20,"height":10}}'
    )
    assert "autoglm-test-secret" not in output[0]
    assert "private pixels" not in output[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("allow_device_actions", "query"),
    [(True, None), (False, "weather in Shanghai"), (True, "   ")],
)
async def test_actions_require_the_flag_and_a_nonempty_query(
    allow_device_actions: bool, query: str | None
) -> None:
    worker = _Worker()
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=allow_device_actions,
        query=query,
        settings=_Settings(),
        emit=output.append,
        **_dependencies(worker),
    )

    assert result == 1
    assert worker.queries == []
    assert output == ["AutoGLM iOS smoke failed"]


@pytest.mark.asyncio
async def test_action_smoke_captures_before_and_after_refs_and_only_bounded_browse_evidence() -> (
    None
):
    worker = _Worker()
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=True,
        query="weather in Shanghai",
        settings=_Settings(),
        emit=output.append,
        **_dependencies(worker),
    )

    assert result == 0
    assert worker.queries == ["weather in Shanghai"]
    assert output == [
        '{"mode":"actions","before":{"media_ref":"media:smoke-0",'
        '"digest":"c7dab3a61c3f17cc936999c73055f622ac00b9d850f1bb4bd7e00daae67a9137",'
        '"media_type":"image/png","width":20,"height":10},'
        '"browse":{"outcome":"ok","code":"completed",'
        '"effect_verification":"not_performed","actions":["tap"]},'
        '"after":{"media_ref":"media:smoke-1",'
        '"digest":"c7dab3a61c3f17cc936999c73055f622ac00b9d850f1bb4bd7e00daae67a9137",'
        '"media_type":"image/png","width":20,"height":10}}'
    ]
    assert "weather in Shanghai" not in output[0]


@pytest.mark.asyncio
async def test_action_smoke_rejects_a_browse_that_did_not_complete() -> None:
    worker = _Worker(
        AutoGlmWorkerResult(
            outcome="failed",
            code="agent_failed",
            effect_verification="not_performed",
            events=({"type": "status", "state": "stopped"},),
        )
    )
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=True,
        query="weather in Shanghai",
        settings=_Settings(),
        emit=output.append,
        **_dependencies(worker),
    )

    assert result == 1
    assert output == ["AutoGLM iOS smoke failed"]


@pytest.mark.asyncio
async def test_action_smoke_rejects_completed_browse_without_action_evidence() -> None:
    worker = _Worker(
        AutoGlmWorkerResult(
            outcome="completed",
            code="completed",
            effect_verification="not_performed",
            events=(),
        )
    )
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=True,
        query="weather in Shanghai",
        settings=_Settings(),
        emit=output.append,
        **_dependencies(worker),
    )

    assert result == 1
    assert output == ["AutoGLM iOS smoke failed"]


@pytest.mark.asyncio
async def test_action_smoke_requires_safari_after_browse() -> None:
    worker = _Worker()
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=True,
        query="weather in Shanghai",
        settings=_Settings(),
        emit=output.append,
        wda_factory=lambda _url: _Wda(("com.apple.mobilesafari", "com.apple.springboard")),
        **{key: value for key, value in _dependencies(worker).items() if key != "wda_factory"},
    )

    assert result == 1
    assert output == ["AutoGLM iOS smoke failed"]


@pytest.mark.asyncio
async def test_preflight_requires_repo_import_device_wda_status_and_screenshot() -> None:
    worker = _Worker()
    output: list[str] = []

    result = await smoke_autoglm_ios.run_smoke(
        allow_device_actions=False,
        query=None,
        settings=_Settings(),
        emit=output.append,
        repo_importer=lambda *_args: False,
        device_visible=lambda _device_id: True,
        wda_status=lambda _url: True,
        wda_factory=lambda _url: _Wda(),
        worker_factory=lambda *_args: worker,
        media_store_factory=MediaStore,
    )

    assert result == 1
    assert output == ["AutoGLM iOS smoke failed"]


def test_bootstrap_uses_the_pinned_submodule_in_an_isolated_venv() -> None:
    bootstrap = _ROOT / "scripts" / "bootstrap_autoglm_ios.sh"

    assert bootstrap.is_file()
    source = bootstrap.read_text(encoding="utf-8")
    assert "thirdparty/Open-AutoGLM" in source
    assert ".autoglm-venv" in source
    assert "python3 -m venv" in source
    assert "pip install -r" in source
    assert "ls-tree HEAD" in source


def test_wda_status_disables_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class _Opener:
        def open(self, url: str, *, timeout: int) -> io.BytesIO:
            calls.append(url)
            assert timeout == 5
            response = io.BytesIO(b'{"value":{}}')
            response.status = 200  # type: ignore[attr-defined]
            return response

    monkeypatch.setattr(
        smoke_autoglm_ios, "build_opener", lambda *_handlers: _Opener(), raising=False
    )

    assert smoke_autoglm_ios._wda_status("http://127.0.0.1:8100") is True
    assert calls == ["http://127.0.0.1:8100/status"]


def test_wda_status_requires_http_200(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Opener:
        def open(self, _url: str, *, timeout: int) -> io.BytesIO:
            assert timeout == 5
            response = io.BytesIO(b'{"value":{}}')
            response.status = 503  # type: ignore[attr-defined]
            return response

    monkeypatch.setattr(
        smoke_autoglm_ios, "build_opener", lambda *_handlers: _Opener(), raising=False
    )

    assert smoke_autoglm_ios._wda_status("http://127.0.0.1:8100") is False


def test_wda_status_rejects_oversized_response(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Opener:
        def open(self, _url: str, *, timeout: int) -> io.BytesIO:
            assert timeout == 5
            response = io.BytesIO(b'{"value":{"padding":"' + b"x" * (64 * 1024) + b'"}}')
            response.status = 200  # type: ignore[attr-defined]
            return response

    monkeypatch.setattr(
        smoke_autoglm_ios, "build_opener", lambda *_handlers: _Opener(), raising=False
    )

    assert smoke_autoglm_ios._wda_status("http://127.0.0.1:8100") is False


def test_iphone_visible_uses_idevice_id_and_filters_configured_device(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def run(argv: tuple[str, ...], **kwargs: object) -> SimpleNamespace:
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout="device-1\ndevice-2\n")

    monkeypatch.setattr(smoke_autoglm_ios.subprocess, "run", run)

    assert smoke_autoglm_ios._iphone_visible("device-2") is True
    assert smoke_autoglm_ios._iphone_visible("missing-device") is False
    assert calls == [
        (
            ("idevice_id", "-l"),
            {
                "stdin": smoke_autoglm_ios.subprocess.DEVNULL,
                "capture_output": True,
                "text": True,
                "check": False,
                "timeout": 20,
            },
        ),
        (
            ("idevice_id", "-l"),
            {
                "stdin": smoke_autoglm_ios.subprocess.DEVNULL,
                "capture_output": True,
                "text": True,
                "check": False,
                "timeout": 20,
            },
        ),
    ]
