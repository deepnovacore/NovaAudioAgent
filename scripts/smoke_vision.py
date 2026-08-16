#!/usr/bin/env python3
"""Run the explicit real-camera, real-VL Stage E acceptance smoke."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from nova_audio_agent.assembly import build_assembly
from nova_audio_agent.config import Settings
from nova_audio_agent.events import ModelDone, UserInput
from nova_audio_agent.memory import MemoryItem
from nova_audio_agent.trace import TraceWriter


def evaluate_smoke(
    *,
    utterances: Sequence[str],
    cam_items: Sequence[MemoryItem],
    memory_text: str,
    trace_text: str,
    forbidden_path: str,
) -> dict[str, Any]:
    if not cam_items:
        raise RuntimeError("没有观察到 cam.snapshot handoff")
    observation = cam_items[-1]
    if observation.trust != "untrusted_external" or observation.outcome != "ok":
        raise RuntimeError("camera observation 不是 ok/untrusted_external")
    required = {
        "media_ref",
        "digest",
        "media_type",
        "width",
        "height",
        "captured_at",
    }
    if set(observation.content) != required:
        raise RuntimeError("camera observation envelope 不完整")
    if any(isinstance(value, bytes) for value in observation.content.values()):
        raise RuntimeError("camera observation 泄露了图片 bytes")

    leak_pattern = re.compile(r"[A-Za-z0-9+/]{256,}={0,2}")
    leak_markers = ("data:image", "base64", "file://", "/Users/", "/private/")
    if any(marker in trace_text for marker in leak_markers) or (
        forbidden_path in trace_text or leak_pattern.search(trace_text)
    ):
        raise RuntimeError("trace 泄露了图片 payload 或本地路径")
    if any(marker in memory_text for marker in leak_markers) or (
        forbidden_path in memory_text or leak_pattern.search(memory_text)
    ):
        raise RuntimeError("Memory 泄露了图片 payload 或本地路径")

    records = tuple(json.loads(line) for line in trace_text.splitlines() if line.strip())
    cam_handoff = next(
        (
            index
            for index, record in enumerate(records)
            if record.get("kind") == "handoff" and record.get("payload", {}).get("channel") == "cam"
        ),
        None,
    )
    fast_done = tuple(
        index
        for index, record in enumerate(records)
        if record.get("kind") == "model_done" and record.get("payload", {}).get("slot") == "fast"
    )
    if (
        cam_handoff is None
        or sum(index < cam_handoff for index in fast_done) != 1
        or not any(index > cam_handoff for index in fast_done)
    ):
        raise RuntimeError("trace 没有证明 cam.snapshot 位于 FastBrain 两跳之间")

    answer = next(
        (text.strip() for text in reversed(tuple(utterances)) if "PERSON=" in text),
        "",
    )
    if "PERSON=YES" not in answer:
        raise RuntimeError("模型没有识别到人")
    if "GLASSES=YES" not in answer:
        raise RuntimeError("模型没有识别到眼镜")
    captured_at = observation.content["captured_at"]
    expected = (
        f"PERSON=YES; GLASSES=YES; OBSERVED_AT={captured_at}"
        if isinstance(captured_at, (int, float))
        else ""
    )
    time_seen = bool(expected) and f"OBSERVED_AT={captured_at}" in answer
    if not time_seen:
        raise RuntimeError("模型回答没有包含 observation time")
    if answer != expected:
        raise RuntimeError("模型回答不符合严格 scene schema")
    return {
        "passed": True,
        "person_seen": True,
        "glasses_seen": True,
        "observation_time_seen": True,
        "media_ref": observation.content["media_ref"],
        "digest": observation.content["digest"],
        "captured_at": captured_at,
        "answer": answer,
    }


def vision_prompt() -> str:
    return (
        "请查看现在的摄像头画面。第一跳只调用 cam.snapshot，不要先回答。拿到画面后，"
        "只输出一行：PERSON=<YES|NO|UNKNOWN>; GLASSES=<YES|NO|UNKNOWN>; "
        "OBSERVED_AT=<captured_at>。PERSON 表示是否看到人；GLASSES 表示看到的人是否戴眼镜；"
        "不确定时必须写 UNKNOWN。"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/nova-audio-agent-vision-smoke.json"),
    )
    return parser


class _CollectingSink:
    def __init__(self) -> None:
        self._chunks: dict[str, list[str]] = {}
        self._order: list[str] = []

    def emit(self, utterance_id: str, text: str) -> None:
        if utterance_id not in self._chunks:
            self._chunks[utterance_id] = []
            self._order.append(utterance_id)
        self._chunks[utterance_id].append(text)

    def end(self, utterance_id: str) -> None:
        del utterance_id

    def utterances(self) -> tuple[str, ...]:
        return tuple("".join(self._chunks[item]) for item in self._order)


async def _wait_for_fresh_frame(source: Any, *, after: float, timeout: float) -> None:
    async with asyncio.timeout(timeout):
        while True:
            frame = source.latest()
            if frame is not None and frame.captured_at > after:
                return
            await asyncio.sleep(0.05)


async def run_live_smoke(
    *,
    camera_index: int,
    timeout: float,
    output: Path,
) -> dict[str, Any]:
    if timeout <= 0:
        raise ValueError("--timeout 必须大于 0")
    trace_path = output.with_suffix(".trace.jsonl")
    output.parent.mkdir(parents=True, exist_ok=True)
    sink = _CollectingSink()
    settings = Settings(fast_model="qwen3-vl-plus")

    with TraceWriter(trace_path) as trace:
        assembly = build_assembly(
            settings,
            sink=sink,
            camera_enabled=True,
            camera_index=camera_index,
            trace=trace,
        )
        stop = asyncio.Event()
        serving: asyncio.Task[None] | None = None
        second_fast_done = asyncio.Event()
        fast_done_count = 0

        def observe(event: object) -> None:
            nonlocal fast_done_count
            if isinstance(event, ModelDone) and event.slot == "fast":
                fast_done_count += 1
                if fast_done_count >= 2:
                    second_fast_done.set()

        remove_observer = assembly.runtime.observe(observe)
        try:
            await assembly.frame_source.start()
            started_at = assembly.runtime.clock.now()
            await _wait_for_fresh_frame(
                assembly.frame_source,
                after=started_at,
                timeout=timeout,
            )
            serving = asyncio.create_task(assembly.runtime.serve(stop))
            assembly.runtime.post(UserInput(vision_prompt()))
            async with asyncio.timeout(timeout):
                await second_fast_done.wait()
        finally:
            remove_observer()
            if serving is not None:
                stop.set()
                await serving
            await assembly.frame_source.stop()

    cam_items = assembly.runtime.memory.channels["cam"].items
    trace_text = trace_path.read_text(encoding="utf-8")
    memory_text = repr(
        {name: channel.items for name, channel in assembly.runtime.memory.channels.items()}
    )
    report = evaluate_smoke(
        utterances=sink.utterances(),
        cam_items=cam_items,
        memory_text=memory_text,
        trace_text=trace_text,
        forbidden_path=str(output.resolve()),
    )
    report["trace"] = str(trace_path)
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> None:
    args = build_parser().parse_args()
    report = asyncio.run(
        run_live_smoke(
            camera_index=args.camera_index,
            timeout=args.timeout,
            output=args.output,
        )
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
