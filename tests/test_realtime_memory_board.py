from __future__ import annotations

import json

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import ObservationEvent
from nova_audio_agent.executors.codex import CODEX_POLICY
from nova_audio_agent.executors.watcher import GUARD_POLICY
from nova_audio_agent.memory import Memory
from nova_audio_agent.memory.policy import CONVERSATION_CHANNEL, USER_PRIORITY
from nova_audio_agent.ports import Delegate
from nova_audio_agent.realtime.memory_board import (
    MAX_BOARD_CONTENT_CHARS,
    MAX_BOARD_ITEMS_PER_CHANNEL,
    MAX_BOARD_MESSAGE_BYTES,
    memory_board_message,
)
from nova_audio_agent.runtime import Runtime


def _fill(memory: Memory, channel: str, count: int, *, text: str = "内容") -> None:
    for index in range(count):
        memory.append(
            channel,
            ts=float(index),
            trust="trusted_user" if channel == CONVERSATION_CHANNEL else "trusted_system",
            priority=USER_PRIORITY,
            content={"text": f"{text}-{index}"},
        )


def test_board_message_enumerates_channels_with_identity_and_items() -> None:
    memory = Memory()
    _fill(memory, CONVERSATION_CHANNEL, 3)

    message = json.loads(memory_board_message("req-1", memory))

    assert message["type"] == "memory.board"
    assert message["request_id"] == "req-1"
    by_name = {channel["name"]: channel for channel in message["channels"]}
    assert CONVERSATION_CHANNEL in by_name
    conversation = by_name[CONVERSATION_CHANNEL]
    assert conversation["item_count"] == 3
    assert [item["seq"] for item in conversation["items"]] == [1, 2, 3]
    first = conversation["items"][0]
    assert first["trust"] == "trusted_user"
    assert first["content"] == json.dumps(
        {"text": "内容-0"}, ensure_ascii=False, separators=(",", ":")
    )


def test_board_message_keeps_only_the_newest_items_per_channel() -> None:
    memory = Memory()
    _fill(memory, CONVERSATION_CHANNEL, MAX_BOARD_ITEMS_PER_CHANNEL + 10)

    message = json.loads(memory_board_message("req-1", memory))

    conversation = next(
        channel for channel in message["channels"] if channel["name"] == CONVERSATION_CHANNEL
    )
    assert conversation["item_count"] == MAX_BOARD_ITEMS_PER_CHANNEL + 10
    assert len(conversation["items"]) == MAX_BOARD_ITEMS_PER_CHANNEL
    assert conversation["items"][-1]["seq"] == MAX_BOARD_ITEMS_PER_CHANNEL + 10
    assert conversation["items"][0]["seq"] == 11


def test_board_message_truncates_oversized_item_content() -> None:
    memory = Memory()
    memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "长" * (MAX_BOARD_CONTENT_CHARS * 2)},
    )

    message = json.loads(memory_board_message("req-1", memory))

    conversation = next(
        channel for channel in message["channels"] if channel["name"] == CONVERSATION_CHANNEL
    )
    item = conversation["items"][0]
    assert len(item["content"]) == MAX_BOARD_CONTENT_CHARS
    assert item["truncated"] is True


def test_board_message_never_exceeds_the_frame_bound() -> None:
    memory = Memory(policies=(CODEX_POLICY,))
    _fill(
        memory,
        CONVERSATION_CHANNEL,
        MAX_BOARD_ITEMS_PER_CHANNEL,
        text="长" * (MAX_BOARD_CONTENT_CHARS - 32),
    )
    _fill(memory, "codex", MAX_BOARD_ITEMS_PER_CHANNEL, text="长" * (MAX_BOARD_CONTENT_CHARS - 32))

    message = memory_board_message("req-1", memory)

    assert len(message.encode("utf-8")) <= MAX_BOARD_MESSAGE_BYTES
    decoded = json.loads(message)
    remaining = sum(len(channel["items"]) for channel in decoded["channels"])
    assert remaining > 0


def test_oversized_channel_summary_cannot_break_the_frame_bound() -> None:
    """A giant compressor summary must be truncated, not returned over-budget."""
    memory = Memory(policies=(CODEX_POLICY,))
    memory.channels[CONVERSATION_CHANNEL].summary = "长" * (400 * 1024)

    message = memory_board_message("req-big-summary", memory)

    assert len(message.encode("utf-8")) <= MAX_BOARD_MESSAGE_BYTES


def test_board_serializes_repeat_monitor_lifecycle_with_distinct_hit_items() -> None:
    clock = VirtualClock()
    memory = Memory(policies=(GUARD_POLICY,))
    origin = memory.append(
        CONVERSATION_CHANNEL,
        ts=0.0,
        trust="trusted_user",
        priority=USER_PRIORITY,
        content={"text": "看到白纸就提醒我"},
    )
    runtime = Runtime(
        clock=clock,
        memory=memory,
        executors={},
        expected_active_executors=frozenset(),
    )
    runtime.delegates.dispatch(
        Delegate(
            delegate_id="d-repeat-board",
            executor="guard",
            op="start",
            request={"condition": "白纸"},
            origin_ref=origin.ref,
            deadline=1800.0,
            routing_class="user_awaited",
            dispatched_at=0.0,
        )
    )
    observations = (
        ("trusted_system", {"state": "armed", "condition": "白纸", "hit_count": 0}, ()),
        (
            "untrusted_external",
            {
                "state": "hit",
                "hit": True,
                "condition": "白纸",
                "observation": "画面中出现白纸",
                "media_ref": "media:first",
                "hit_count": 1,
            },
            ("media:first",),
        ),
        ("trusted_system", {"state": "cooling", "condition": "白纸", "hit_count": 1}, ()),
        (
            "trusted_system",
            {"state": "waiting_reset", "condition": "白纸", "hit_count": 1},
            (),
        ),
        ("trusted_system", {"state": "armed", "condition": "白纸", "hit_count": 1}, ()),
        (
            "untrusted_external",
            {
                "state": "hit",
                "hit": True,
                "condition": "白纸",
                "observation": "白纸再次出现",
                "media_ref": "media:second",
                "hit_count": 2,
            },
            ("media:second",),
        ),
        ("trusted_system", {"state": "cooling", "condition": "白纸", "hit_count": 2}, ()),
    )
    for seq, (trust, content, refs) in enumerate(observations, 1):
        runtime._process_event(
            ObservationEvent(
                channel="guard",
                delegate_id="d-repeat-board",
                op="start",
                origin_ref=origin.ref,
                trust=trust,
                content=content,
                refs=refs,
                ts=float(seq),
                seq=seq,
            ),
            reclaim=False,
        )

    encoded = memory_board_message("repeat-board", memory)
    board = json.loads(encoded)
    guard = next(channel for channel in board["channels"] if channel["name"] == "guard")
    contents = [json.loads(item["content"]) for item in guard["items"]]

    assert len(encoded.encode("utf-8")) <= MAX_BOARD_MESSAGE_BYTES
    assert [content["state"] for content in contents] == [
        "armed",
        "hit",
        "cooling",
        "waiting_reset",
        "armed",
        "hit",
        "cooling",
    ]
    hit_items = [
        (item, content)
        for item, content in zip(guard["items"], contents, strict=True)
        if content["state"] == "hit"
    ]
    assert [content["hit_count"] for _, content in hit_items] == [1, 2]
    assert [item["trust"] for item, _ in hit_items] == [
        "untrusted_external",
        "untrusted_external",
    ]
    assert len({f"guard:{item['seq']}" for item, _ in hit_items}) == 2
    assert [item["refs"][-1] for item, _ in hit_items] == ["media:first", "media:second"]
