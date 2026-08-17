"""Opt-in live latency and function-call benchmark for Ark realtime LLM candidates."""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable, Sequence
from dataclasses import asdict, replace
import inspect
import json
import math
import os
import random
import time
from typing import Any
from urllib.parse import urlsplit

from openai import AsyncOpenAI

from nova_audio_agent.realtime.qwen import FRONTEND_INSTRUCTIONS
from nova_audio_agent.realtime.volcengine.ark import ArkResponsesClient
from nova_audio_agent.realtime.volcengine.benchmark import (
    AttemptResult,
    CaseScore,
    ModelSummary,
    benchmark_cases,
    candidate_passes_gate,
    run_attempt,
    summarize_model,
)

BASELINE_MODEL = "doubao-seed-2-0-pro-260215"
MODEL_CHOICES = (
    BASELINE_MODEL,
    "doubao-seed-2-1-pro-260628",
    "doubao-seed-2-1-turbo-260628",
    "deepseek-v4-pro-ga-260813",
    "deepseek-v4-flash-ga-260731",
    "doubao-seed-2-0-lite-260428",
    "doubao-seed-1-6-flash-250828",
    "doubao-seed-1-8-251228",
    "glm-5-2-260617",
    "kimi-k2-250905",
    "doubao-seed-2-0-mini-260428",
)
DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
_SCHEDULE_SEED = 20260818


def _bounded_runs(value: str) -> int:
    runs = int(value)
    if not 1 <= runs <= 5:
        raise argparse.ArgumentTypeError("runs must be between 1 and 5")
    return runs


def _positive_timeout(value: str) -> float:
    timeout = float(value)
    if not math.isfinite(timeout) or timeout <= 0:
        raise argparse.ArgumentTypeError("timeout must be positive")
    return timeout


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="authorize real Ark API calls")
    parser.add_argument(
        "--models",
        nargs="+",
        choices=MODEL_CHOICES,
        default=list(MODEL_CHOICES),
        help="allowlisted Ark model IDs to compare",
    )
    parser.add_argument("--runs", type=_bounded_runs, default=2)
    parser.add_argument("--timeout", type=_positive_timeout, default=30.0)
    return parser


def _validated_base_url() -> str:
    value = os.environ.get("NOVA_AUDIO_AGENT_VOLCENGINE_ARK_BASE_URL", DEFAULT_BASE_URL)
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Ark base URL must be a credential-free https URL")
    return value.rstrip("/")


def _live_client_factory(timeout: float) -> Callable[[str], ArkResponsesClient]:
    api_key = os.environ.get("ARK_API_KEY")
    if not api_key:
        raise ValueError("ARK_API_KEY is required")
    base_url = _validated_base_url()

    def create(model: str) -> ArkResponsesClient:
        return ArkResponsesClient(
            client=AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout),
            model=model,
            instructions=FRONTEND_INSTRUCTIONS,
        )

    return create


def _selected_models(models: Sequence[str]) -> tuple[str, ...]:
    selected = list(dict.fromkeys(models))
    if BASELINE_MODEL not in selected:
        selected.insert(0, BASELINE_MODEL)
    return tuple(selected)


async def run_matrix(
    args: argparse.Namespace,
    *,
    client_factory: Callable[[str], Any] | None = None,
) -> list[ModelSummary]:
    if not args.live:
        raise ValueError("live provider calls require --live")
    if client_factory is None:
        client_factory = _live_client_factory(args.timeout)

    models = _selected_models(args.models)
    clients: dict[str, Any] = {}
    summaries: list[ModelSummary] | None = None
    close_failures = 0
    try:
        for model in models:
            clients[model] = client_factory(model)
        cases = benchmark_cases()
        schedule = [
            (model, case, repeat)
            for repeat in range(args.runs)
            for case in cases
            for model in models
        ]
        random.Random(_SCHEDULE_SEED).shuffle(schedule)
        attempts: dict[str, list[AttemptResult]] = {model: [] for model in models}
        for model, case, repeat in schedule:
            try:
                async with asyncio.timeout(args.timeout):
                    result = await run_attempt(
                        clients[model], model, case, repeat=repeat, clock=time.perf_counter
                    )
            except TimeoutError:
                failed = CaseScore(
                    passed=False,
                    correct_tool=False,
                    valid_arguments=False,
                    unexpected_tool=False,
                    mixed_text_and_tool=False,
                    provider_failed=True,
                    protocol_failed=False,
                    continuation_passed=None,
                    severe_failure=True,
                )
                result = AttemptResult(
                    model=model,
                    case_id=case.case_id,
                    category=case.category,
                    repeat=repeat,
                    score=failed,
                    response_created_ms=None,
                    first_text_ms=None,
                    function_call_ms=None,
                    continuation_first_text_ms=None,
                    terminal_ms=None,
                    error_class="TimeoutError",
                )
            attempts[model].append(result)
        summaries = [summarize_model(model, attempts[model]) for model in models]
    finally:
        closed: set[int] = set()
        for client in clients.values():
            if id(client) in closed:
                continue
            closed.add(id(client))
            close = getattr(client, "close", None)
            if close is None:
                continue
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                close_failures += 1

    if summaries is None:
        raise RuntimeError("benchmark did not produce summaries")
    if close_failures:
        first = summaries[0]
        error_classes = dict(first.error_classes)
        error_classes["ClientCloseError"] = close_failures
        summaries[0] = replace(
            first,
            provider_failures=first.provider_failures + close_failures,
            error_classes=error_classes,
        )
    return summaries


def public_report(summaries: Sequence[ModelSummary]) -> dict[str, Any]:
    by_model = {summary.model: summary for summary in summaries}
    baseline = by_model.get(BASELINE_MODEL)
    if baseline is None:
        raise ValueError("baseline model summary is required")
    models: list[dict[str, Any]] = []
    for summary in sorted(summaries, key=lambda item: MODEL_CHOICES.index(item.model)):
        item = asdict(summary)
        item["passes_baseline_gate"] = (
            True if summary.model == BASELINE_MODEL else candidate_passes_gate(baseline, summary)
        )
        models.append(item)
    return {"baseline_model": BASELINE_MODEL, "models": models}


async def _main(args: argparse.Namespace) -> int:
    summaries = await run_matrix(args)
    print(json.dumps(public_report(summaries), ensure_ascii=False, indent=2, sort_keys=True))
    return int(
        any(
            summary.provider_failures or summary.protocol_failures or summary.error_classes
            for summary in summaries
        )
    )


def main() -> int:
    args = build_parser().parse_args()
    try:
        return asyncio.run(_main(args))
    except Exception as exc:
        print(f"volcengine LLM benchmark failed ({type(exc).__name__})")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
