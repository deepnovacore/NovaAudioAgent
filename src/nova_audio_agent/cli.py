"""Typer entry points for chat, local scorecard, and acceptance demos."""

from __future__ import annotations

import asyncio
import codecs
from io import UnsupportedOperation
import os
from pathlib import Path
import sys
import threading

import typer

from nova_audio_agent.assembly import (
    Assembly,
    _active_executor_names,
    build_assembly,
    resolve_camera_source,
)
from nova_audio_agent.config import ConfigurationError, Settings
from nova_audio_agent.executors.camera import CameraError
from nova_audio_agent.executors.codex_projects import CodexProjectStore, ProjectStateError
from nova_audio_agent.model_gateway import GatewayError
from nova_audio_agent.speech import CliSpeechSink
from nova_audio_agent.uploads import UploadError, build_user_input

app = typer.Typer(help="Nova Audio Agent interactive harness")
demo_app = typer.Typer(help="Run deterministic acceptance scenarios")
workspace_app = typer.Typer(help="Manage trusted local Codex workspaces")
app.add_typer(demo_app, name="demo")
app.add_typer(workspace_app, name="workspace")


def _project_store() -> CodexProjectStore:
    managed_root, state_root = Settings().require_codex_projects()
    return CodexProjectStore(state_root, managed_root)


@workspace_app.command("list")
def workspace_list_command() -> None:
    """List registered workspace display names without local paths."""
    try:
        store = _project_store()
        snapshot = store.snapshot()
    except (ConfigurationError, ProjectStateError) as exc:
        typer.echo(f"错误：{getattr(exc, 'code', str(exc))}", err=True)
        raise typer.Exit(1) from exc
    for workspace in snapshot.workspaces:
        marker = "*" if workspace.workspace_id == snapshot.active_workspace_id else "-"
        typer.echo(f"{marker} {workspace.display_name}")


@workspace_app.command("register")
def workspace_register_command(display_name: str, path: Path) -> None:
    """Register one existing trusted local directory by exact display name."""
    try:
        workspace = _project_store().register_workspace(display_name, path)
    except (ConfigurationError, ProjectStateError) as exc:
        typer.echo(f"错误：{getattr(exc, 'code', str(exc))}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"已注册：{workspace.display_name}")


def _write_stream(text: str) -> None:
    typer.echo(text, nl=False)


def _settings(executor: str | None = None) -> Settings:
    if executor is None:
        return Settings()
    if executor not in {"fast_sim", "slow_sim", "ha", "codex", "autoglm"}:
        raise typer.BadParameter("executor 必须是 fast_sim、slow_sim、ha、codex 或 autoglm")
    return Settings(executor=executor)  # type: ignore[arg-type]


async def _read_input(prompt: str) -> str:
    """Read one line without leaving a non-cancellable executor thread behind."""
    typer.echo(prompt, nl=False)
    loop = asyncio.get_running_loop()
    future: asyncio.Future[str] = loop.create_future()
    stream = sys.stdin

    def settle(line: str | None = None, error: BaseException | None = None) -> None:
        if future.done():
            return
        if error is not None:
            future.set_exception(error)
        else:
            assert line is not None
            future.set_result(line)

    def read_in_thread() -> None:
        try:
            line = stream.readline()
        except BaseException as exc:
            callback_args = (None, exc)
        else:
            callback_args = (line, None)
        try:
            loop.call_soon_threadsafe(settle, *callback_args)
        except RuntimeError:
            pass  # The cancelled CLI has already closed its event loop.

    reader_fd: int | None = None
    try:
        reader_fd = stream.fileno()
        decoder = codecs.getincrementaldecoder(stream.encoding or "utf-8")(
            errors=stream.errors or "strict"
        )
        parts: list[str] = []

        def read_ready() -> None:
            assert reader_fd is not None
            try:
                # This bypasses TextIOWrapper buffering; _read_input must remain
                # the process's sole stdin consumer.
                chunk = os.read(reader_fd, 1)
                parts.append(decoder.decode(chunk, final=not chunk))
            except BaseException as exc:
                loop.remove_reader(reader_fd)
                settle(error=exc)
                return
            if chunk and "\n" not in parts[-1]:
                return
            loop.remove_reader(reader_fd)
            settle(line="".join(parts))

        loop.add_reader(reader_fd, read_ready)
    except (AttributeError, NotImplementedError, OSError, UnsupportedOperation):
        reader_fd = None
        threading.Thread(target=read_in_thread, daemon=True).start()

    try:
        line = await future
    finally:
        if reader_fd is not None:
            loop.remove_reader(reader_fd)
    if line == "":
        raise EOFError
    return line.rstrip("\r\n")


@app.command()
def chat(
    executor: str | None = typer.Option(None, "--executor"),
    camera: bool = typer.Option(False, "--camera"),
    camera_source: str = typer.Option("auto", "--camera-source"),
    camera_index: int = typer.Option(0, "--camera-index", min=0),
) -> None:
    """Keep serving user input until /quit, /exit, EOF, or Ctrl-C."""
    try:
        asyncio.run(
            _chat(
                _settings(executor),
                camera_source=camera_source,
                camera_enabled=camera,
                camera_index=camera_index,
            )
        )
    except (CameraError, ConfigurationError, GatewayError) as exc:
        typer.echo(f"错误：{exc}", err=True)
        raise typer.Exit(1) from exc


async def _chat(
    settings: Settings,
    *,
    camera_source: str = "auto",
    camera_enabled: bool = False,
    camera_index: int = 0,
) -> None:
    settings.require_api_key()
    settings.require_tavily_api_key()
    active_names, _ = _active_executor_names(settings)
    resolve_camera_source(
        active_executors=frozenset(active_names),
        requested=camera_source,
        legacy_camera=camera_enabled,
        camera_index=camera_index,
    )
    sink = CliSpeechSink(_write_stream)
    stop = asyncio.Event()
    assembly: Assembly | None = None
    runtime = None
    serving: asyncio.Task[None] | None = None
    try:
        while serving is None or not serving.done():
            try:
                line = await _read_input("you> ")
            except (EOFError, KeyboardInterrupt):
                break
            if line.strip() in {"/quit", "/exit"}:
                break
            if line.strip():
                if assembly is None:
                    assembly = build_assembly(
                        settings,
                        sink=sink,
                        camera_source=camera_source,  # type: ignore[arg-type]
                        camera_enabled=camera_enabled,
                        camera_index=camera_index,
                    )
                    await assembly.start()
                    runtime = assembly.runtime
                    serving = asyncio.create_task(runtime.serve(stop))
                assert runtime is not None
                try:
                    event = build_user_input(
                        line,
                        store=assembly.media_store,
                        captured_at=runtime.clock.now(),
                    )
                except UploadError as exc:
                    typer.echo(f"错误：{exc}", err=True)
                    continue
                if event.text or event.media_refs:
                    runtime.post(event)
        if serving is not None and serving.done():
            await serving
    finally:
        if serving is not None:
            stop.set()
            await serving
        if assembly is not None:
            await assembly.stop()


@app.command()
def scorecard(
    runs: int = typer.Option(3, "--runs", min=1),
    output: Path = typer.Option(Path("scorecard.json"), "--output"),
) -> None:
    """Run the non-gating real-model scorecard and write JSON plus Markdown."""
    try:
        paths = asyncio.run(_scorecard(_settings(), runs=runs, output=output))
    except (ConfigurationError, GatewayError) as exc:
        typer.echo(f"错误：{exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"scorecard: {paths[0]}")
    typer.echo(f"markdown: {paths[1]}")


async def _scorecard(settings: Settings, *, runs: int, output: Path) -> tuple[Path, Path]:
    from openai import AsyncOpenAI

    from nova_audio_agent.clock import RealClock
    from nova_audio_agent.executors.search import SEARCH_MANIFEST
    from nova_audio_agent.executors.sims import SlowSim
    from nova_audio_agent.model_gateway import OpenAIModelGateway
    from nova_audio_agent.scorecard import run_live_scorecard, write_scorecard
    from nova_audio_agent.tool_schema import compile_tool_schema

    api_key = settings.require_api_key()
    gateway = OpenAIModelGateway(
        AsyncOpenAI(api_key=api_key, base_url=settings.model_base_url),
        clock=RealClock(),
    )
    tools = compile_tool_schema((SEARCH_MANIFEST, SlowSim().manifest))
    report = await run_live_scorecard(
        gateway,
        tools=tools,
        fast_model=settings.fast_model,
        surrogate_model=settings.surrogate_model,
        runs=runs,
    )
    return write_scorecard(report, output)


def _demo(names: tuple[str, ...]) -> None:
    from nova_audio_agent.demos import run_demos

    try:
        results = asyncio.run(run_demos(names, settings=_settings(), writer=_write_stream))
    except (ConfigurationError, GatewayError) as exc:
        typer.echo(f"错误：{exc}", err=True)
        raise typer.Exit(1) from exc
    if not all(result.passed for result in results):
        raise typer.Exit(1)


@demo_app.command("async")
def demo_async_command() -> None:
    """Show a second response completing before an earlier handoff."""
    _demo(("async",))


@demo_app.command("dual-axis")
def demo_dual_axis_command() -> None:
    """Show one FastBrain call speaking and dispatching."""
    _demo(("dual-axis",))


@demo_app.command("timeout")
def demo_timeout_command() -> None:
    """Show deadline, unknown, and uncertainty wording."""
    _demo(("timeout",))


@demo_app.command("proactive")
def demo_proactive_command() -> None:
    """Show Surrogate selecting material before FastBrain speaks."""
    _demo(("proactive",))


@demo_app.command("all")
def demo_all_command() -> None:
    """Run all four acceptance scenarios."""
    _demo(("async", "dual-axis", "timeout", "proactive"))
