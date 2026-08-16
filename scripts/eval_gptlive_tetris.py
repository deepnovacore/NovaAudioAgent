#!/usr/bin/env python3
"""Run the opt-in live Codex/Tetris M1 acceptance scenario."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any, Mapping

from openai import AsyncOpenAI

from nova_audio_agent.assembly import build_codex_live_assembly
from nova_audio_agent.config import Settings
from nova_audio_agent.evals.live_tetris import (
    CauseTracker,
    EvaluationRecorder,
    EvaluationSpeechSink,
    JudgeConfig,
    LiveTetrisFailure,
    LiveTetrisDriver,
    RecordingCodexAdapter,
    runtime_observer,
)
from nova_audio_agent.evals.tetris_artifact import create_contracted_workspace
from nova_audio_agent.speech import RecordingSink

JUDGE_PROMPT_VERSION = "gptlive-tetris-interaction-v1"


async def _main(args: argparse.Namespace) -> int:
    with create_contracted_workspace() as workspace:
        settings = Settings(
            executor="codex",
            codex_workspace=workspace,
        )
        recorder = EvaluationRecorder()
        causes = CauseTracker()
        clock_sink_holder: dict[str, RecordingSink] = {}

        class _LateSink:
            def emit(self, utterance_id: str, text: str) -> None:
                clock_sink_holder["sink"].emit(utterance_id, text)

            def end(self, utterance_id: str) -> None:
                clock_sink_holder["sink"].end(utterance_id)

        evaluation_sink = EvaluationSpeechSink(_LateSink(), recorder, causes)
        assembly = build_codex_live_assembly(settings, sink=evaluation_sink)
        clock_sink_holder["sink"] = RecordingSink(assembly.runtime.clock)
        codex = assembly.runtime.executors["codex"]
        assembly.runtime.executors["codex"] = RecordingCodexAdapter(codex, recorder)
        assembly.runtime.observe(runtime_observer(recorder, causes))

        judge = None
        judge_config = None
        if args.judge_model:
            judge_config = JudgeConfig(
                provider="openai-compatible",
                model=args.judge_model,
                prompt_version=JUDGE_PROMPT_VERSION,
            )
            judge = _judge_callable(settings)
        await assembly.start()
        try:
            try:
                report = await LiveTetrisDriver(
                    runtime=assembly.runtime,
                    recorder=recorder,
                    workspace=workspace,
                    timeout=args.timeout,
                    judge=judge,
                    judge_config=judge_config,
                ).run()
            except LiveTetrisFailure as failure:
                failure.records = recorder.records
                raise
        finally:
            await assembly.stop()
        args.output.write_text(
            json.dumps(report.to_mapping(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return 0 if report.hard_pass else 1


def _judge_callable(settings: Settings):
    client = AsyncOpenAI(
        api_key=settings.require_api_key(),
        base_url=settings.model_base_url,
    )

    async def judge(view: Mapping[str, Any], config: JudgeConfig) -> Mapping[str, Any]:
        response = await client.chat.completions.create(
            model=config.model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Evaluate interaction quality only, never code correctness. Return JSON with "
                        "verdict pass|finding, integer scores 0..4, evidence_refs from the supplied "
                        "events, and a short summary."
                    ),
                },
                {"role": "user", "content": json.dumps(view, ensure_ascii=False)},
            ],
        )
        content = response.choices[0].message.content
        return json.loads(content or "{}")

    return judge


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--judge-model")
    parser.add_argument("--timeout", type=float, default=600.0)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        return asyncio.run(_main(args))
    except Exception as failure:
        records = getattr(failure, "records", ())
        args.output.write_text(
            json.dumps(
                {
                    "hard_pass": False,
                    "error": getattr(failure, "code", type(failure).__name__),
                    "records": [dict(record) for record in records],
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
