#!/usr/bin/env python3
"""Safe local preflight and explicitly gated Safari smoke for AutoGLM iOS."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.autoglm import AUTOGLM_MANIFEST, AutoGlmAdapter, AutoGlmWdaClient
from nova_audio_agent.executors.autoglm_transport import AutoGlmRunDeadline, AutoGlmTransport
from nova_audio_agent.media import MediaStore
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate


class _Settings(Protocol):
    def require_autoglm(self) -> tuple[Path, str, str, str, Any, str, str | None]: ...


WdaFactory = Callable[[str], Any]
WorkerFactory = Callable[[str, Path, str, str, Any, str, str | None], Any]
RepoImporter = Callable[[str, Path], bool]
DeviceVisible = Callable[[str | None], bool]
WdaStatus = Callable[[str], bool]
Emit = Callable[[str], None]

_MAX_WDA_STATUS_BYTES = 64 * 1024
_ACTION_KINDS = frozenset({"tap", "input", "swipe", "home", "wait"})
_RESULT_CODES = frozenset(
    {
        "completed",
        "agent_failed",
        "max_steps_reached",
        "current_app_not_allowed",
        "non_safari_launch",
        "safari_not_foreground",
        "sensitive_action",
        "takeover_requested",
        "unsupported_action",
        "invalid_action",
        "agent_setup_failed",
        "agent_step_failed",
        "timeout",
        "spawn_failed",
        "stream_failure",
        "transport_failure",
        "nonzero_exit",
        "credential_output",
    }
)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args: object, **_kwargs: object) -> None:
        return None


def _repo_imported(external_python: str, repo: Path) -> bool:
    try:
        completed = subprocess.run(
            (external_python, "-c", "import phone_agent.agent_ios, phone_agent.model"),
            cwd=repo,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def _iphone_visible(device_id: str | None) -> bool:
    try:
        completed = subprocess.run(
            ("idevice_id", "-l"),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if completed.returncode != 0:
        return False
    devices = {line.strip() for line in completed.stdout.splitlines() if line.strip()}
    return device_id in devices if device_id else bool(devices)


def _fixed_wda_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port != 8100
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    return f"http://{parsed.hostname}:8100"


def _wda_status(url: str) -> bool:
    try:
        opener = build_opener(_NoRedirect())
        with opener.open(f"{url}/status", timeout=5) as response:  # noqa: S310 - fixed loopback URL
            if getattr(response, "status", None) != 200:
                return False
            body = response.read(_MAX_WDA_STATUS_BYTES + 1)
            if len(body) > _MAX_WDA_STATUS_BYTES:
                return False
            payload = json.loads(body.decode("utf-8"), parse_constant=_reject_json_constant)
    except Exception:
        return False
    return type(payload) is dict and type(payload.get("value")) is dict


def _worker(
    external_python: str,
    repo: Path,
    base_url: str,
    model: str,
    api_key: Any,
    wda_url: str,
    device_id: str | None,
) -> AutoGlmTransport:
    return AutoGlmTransport(
        runner_path=Path(__file__).with_name("autoglm_ios_runner.py"),
        external_python=external_python,
        repo=repo,
        model_endpoint=base_url,
        model_name=model,
        api_key=api_key.get_secret_value(),
        wda_url=wda_url,
        device_id=device_id,
    )


def _reject_json_constant(_value: str) -> None:
    raise ValueError("non-standard JSON constant")


def _context(op: str, request: dict[str, str], clock: RealClock) -> DispatchContext:
    spec = AUTOGLM_MANIFEST.op(op)
    assert spec is not None
    delegate = bind_delegate(
        DelegateRequest(executor="autoglm", op=op, request=request, origin_ref="smoke:0"),
        wake_reason=WakeReason(kind="smoke", priority=0, routing_class="user_awaited"),
        op=spec,
        now=clock.now(),
        delegate_id=f"smoke-{op}",
    )
    return DispatchContext(clock=clock, delegate=delegate)


async def _capture(adapter: AutoGlmAdapter, clock: RealClock) -> dict[str, object] | None:
    handoff = await adapter.dispatch("screenshot", {}, _context("screenshot", {}, clock))
    content = handoff.content
    required = ("media_ref", "digest", "media_type", "width", "height")
    if handoff.outcome != "ok" or type(content) is not dict or not set(required) <= set(content):
        return None
    result = {key: content[key] for key in required}
    if (
        not isinstance(result["media_ref"], str)
        or not isinstance(result["digest"], str)
        or result["media_type"] != "image/png"
        or type(result["width"]) is not int
        or type(result["height"]) is not int
    ):
        return None
    return result


def _browse_evidence(handoff: object) -> dict[str, object] | None:
    outcome = getattr(handoff, "outcome", None)
    content = getattr(handoff, "content", None)
    if outcome not in {"ok", "failed", "unknown"} or type(content) is not dict:
        return None
    code = content.get("code", content.get("error"))
    effect = content.get("effect_verification")
    events = content.get("events")
    if (
        not isinstance(code, str)
        or code not in _RESULT_CODES
        or effect != "not_performed"
        or not isinstance(events, list)
    ):
        return None
    actions: list[str] = []
    for event in events:
        if type(event) is dict and event.get("type") == "action":
            kind = event.get("kind")
            if type(kind) is not str or kind not in _ACTION_KINDS:
                return None
            actions.append(kind)
    return {
        "outcome": outcome,
        "code": code,
        "effect_verification": effect,
        "actions": actions,
    }


async def run_smoke(
    *,
    allow_device_actions: bool,
    query: str | None,
    settings: _Settings | None = None,
    repo_importer: RepoImporter = _repo_imported,
    device_visible: DeviceVisible = _iphone_visible,
    wda_status: WdaStatus = _wda_status,
    wda_factory: WdaFactory = AutoGlmWdaClient,
    worker_factory: WorkerFactory = _worker,
    media_store_factory: Callable[[], MediaStore] = MediaStore,
    emit: Emit = print,
) -> int:
    """Run read-only preflight, or one explicitly approved bounded Safari browse."""

    normalized_query = (query or "").strip()
    action_mode = allow_device_actions and bool(normalized_query)
    if allow_device_actions != bool(normalized_query):
        emit("AutoGLM iOS smoke failed")
        return 1

    try:
        configured = Settings(executor="autoglm") if settings is None else settings
        repo, external_python, base_url, model, api_key, configured_wda_url, device_id = (
            configured.require_autoglm()
        )
        wda_url = _fixed_wda_url(configured_wda_url)
        if (
            wda_url is None
            or not repo_importer(external_python, repo)
            or not device_visible(device_id)
            or not wda_status(wda_url)
        ):
            raise ValueError("preflight_failed")
        wda = wda_factory(wda_url)
        store = media_store_factory()
        clock = RealClock()
        before = await _capture(AutoGlmAdapter(_UnavailableWorker(), wda, store), clock)
        if before is None:
            raise ValueError("screenshot_failed")
        if not action_mode:
            emit(
                json.dumps(
                    {
                        "mode": "preflight",
                        "repo_imported": True,
                        "iphone_visible": True,
                        "wda_status": True,
                        "model_configured": True,
                        "screenshot": before,
                    },
                    separators=(",", ":"),
                )
            )
            return 0

        worker = worker_factory(external_python, repo, base_url, model, api_key, wda_url, device_id)
        adapter = AutoGlmAdapter(worker, wda, store)
        browse = await adapter.dispatch(
            "browse",
            {"query": normalized_query},
            _context("browse", {"query": normalized_query}, clock),
        )
        evidence = _browse_evidence(browse)
        if (
            evidence is None
            or evidence["outcome"] != "ok"
            or evidence["code"] != "completed"
            or not evidence["actions"]
        ):
            raise ValueError("browse_failed")
        if await wda.active_bundle_id() != "com.apple.mobilesafari":
            raise ValueError("safari_not_foreground")
        after = await _capture(adapter, clock)
        if after is None:
            raise ValueError("action_evidence_failed")
        emit(
            json.dumps(
                {"mode": "actions", "before": before, "browse": evidence, "after": after},
                separators=(",", ":"),
            )
        )
        return 0
    except Exception:
        emit("AutoGLM iOS smoke failed")
        return 1


class _UnavailableWorker:
    async def run_browse(self, query: str, *, deadline: AutoGlmRunDeadline) -> object:
        del query, deadline
        raise RuntimeError("preflight does not browse")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Safe local AutoGLM iPhone smoke")
    parser.add_argument("--allow-device-actions", action="store_true")
    parser.add_argument("--query")
    args = parser.parse_args(argv)
    return asyncio.run(run_smoke(allow_device_actions=args.allow_device_actions, query=args.query))


if __name__ == "__main__":
    sys.exit(main())
