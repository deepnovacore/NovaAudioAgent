#!/usr/bin/env python3
"""Measure the Codex prewarm benefit: dispatch -> turn/started, lazy vs warm.

Runs the real ``codex`` binary through ``CodexLiveAdapter`` with a trivial work
order. Lazy mode dispatches cold (per-run preflight + spawn + handshake +
thread/start on the critical path); warm mode calls ``prewarm()`` first so the
dispatch only pays ``turn/start``. Wall-clock calls live here in ``scripts/``,
outside the hygiene-scanned package.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

from nova_audio_agent.clock import RealClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.codex import RUN
from nova_audio_agent.executors.codex_app_server import CodexAppServerTransport
from nova_audio_agent.executors.codex_live import CodexLiveAdapter
from nova_audio_agent.ports import DelegateRequest, DispatchContext, bind_delegate

WORK_ORDER = "Reply with exactly the single word OK. Do not run commands or modify any files."
USER_WAKE = WakeReason(kind="user_input", priority=100, routing_class="user_awaited")


def _context(clock: RealClock, index: int, on_progress) -> DispatchContext:
    delegate = bind_delegate(
        DelegateRequest(
            executor="codex",
            op="run",
            request={"work_order": WORK_ORDER},
            origin_ref="conversation:1",
        ),
        wake_reason=USER_WAKE,
        op=RUN,
        now=clock.now(),
        delegate_id=f"d-measure-{index}",
    )
    return DispatchContext(clock=clock, delegate=delegate, progress=on_progress)


async def _measure_once(adapter: CodexLiveAdapter, clock: RealClock, index: int) -> dict:
    marks: dict[str, float] = {}

    def on_progress(payload) -> None:
        if payload.phase == "started" and "turn_started" not in marks:
            marks["turn_started"] = time.monotonic()

    dispatched = time.monotonic()
    handoff = await adapter.dispatch(
        "run", {"work_order": WORK_ORDER}, _context(clock, index, on_progress)
    )
    finished = time.monotonic()
    return {
        "outcome": handoff.outcome,
        "code": handoff.content.get("code"),
        "dispatch_to_turn_started_s": (
            marks["turn_started"] - dispatched if "turn_started" in marks else None
        ),
        "dispatch_to_handoff_s": finished - dispatched,
    }


async def _run_mode(mode: str, binary: str, workspace: Path, iterations: int) -> list[dict]:
    clock = RealClock()
    samples = []
    for index in range(iterations):
        transport = CodexAppServerTransport(binary=binary, workspace=workspace)
        adapter = CodexLiveAdapter(transport)
        if mode == "warm":
            warm_started = time.monotonic()
            await adapter.prewarm()
            warm_elapsed = time.monotonic() - warm_started
            if adapter.status.prewarm != "ready":
                raise SystemExit(f"prewarm failed on iteration {index}")
        else:
            warm_elapsed = None
        sample = await _measure_once(adapter, clock, index)
        sample["mode"] = mode
        sample["prewarm_s"] = warm_elapsed
        samples.append(sample)
        print(json.dumps(sample, ensure_ascii=False), flush=True)
        await adapter.aclose()
    return samples


def _summarize(samples: list[dict], key: str) -> dict:
    values = [sample[key] for sample in samples if sample.get(key) is not None]
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "median_s": round(statistics.median(values), 3),
        "min_s": round(min(values), 3),
        "max_s": round(max(values), 3),
    }


async def _main(args: argparse.Namespace) -> int:
    with tempfile.TemporaryDirectory(prefix="nova-prewarm-measure-") as raw:
        workspace = Path(raw)
        subprocess.run(["git", "init", "-q", str(workspace)], check=True)
        (workspace / "README.md").write_text("measurement workspace\n")
        subprocess.run(["git", "-C", str(workspace), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(workspace), "commit", "-qm", "init"],
            check=True,
            env={
                "GIT_AUTHOR_NAME": "measure",
                "GIT_AUTHOR_EMAIL": "measure@local",
                "GIT_COMMITTER_NAME": "measure",
                "GIT_COMMITTER_EMAIL": "measure@local",
                "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
            },
        )
        lazy = await _run_mode("lazy", args.binary, workspace, args.iterations)
        warm = await _run_mode("warm", args.binary, workspace, args.iterations)
    report = {
        "work_order": WORK_ORDER,
        "iterations": args.iterations,
        "lazy": {
            "dispatch_to_turn_started": _summarize(lazy, "dispatch_to_turn_started_s"),
            "dispatch_to_handoff": _summarize(lazy, "dispatch_to_handoff_s"),
        },
        "warm": {
            "prewarm": _summarize(warm, "prewarm_s"),
            "dispatch_to_turn_started": _summarize(warm, "dispatch_to_turn_started_s"),
            "dispatch_to_handoff": _summarize(warm, "dispatch_to_handoff_s"),
        },
        "samples": lazy + warm,
    }
    output = json.dumps(report, ensure_ascii=False, indent=2)
    print(output)
    if args.output:
        args.output.write_text(output + "\n", encoding="utf-8")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="codex")
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args)))


if __name__ == "__main__":
    main()
