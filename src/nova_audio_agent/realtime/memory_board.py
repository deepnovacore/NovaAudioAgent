"""Read-only Memory Board serialization: one bounded frame per explicit request.

The board is a viewer, not a second dialogue truth: it renders the live process's
`memory.channels` snapshot and persists nothing (R100).
"""

from __future__ import annotations

import json
from typing import Any

MAX_BOARD_MESSAGE_BYTES = 256 * 1024
MAX_BOARD_ITEMS_PER_CHANNEL = 50
MAX_BOARD_CONTENT_CHARS = 2048
MAX_BOARD_SUMMARY_CHARS = 4096


def memory_board_message(request_id: str, memory: Any) -> str:
    """Serialize every channel's newest items into one bounded text frame.

    When the encoded frame exceeds the byte bound, the oldest retained items are
    dropped round-robin across channels; if fixed fields (summaries) still exceed
    the bound, summaries are dropped entirely rather than returning an over-budget
    frame.
    """
    channels = [_channel_view(channel) for channel in memory.channels.values()]
    summaries_dropped = False
    while True:
        message = json.dumps(
            {"type": "memory.board", "request_id": request_id, "channels": channels},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if len(message.encode("utf-8")) <= MAX_BOARD_MESSAGE_BYTES:
            return message
        populated = [channel for channel in channels if channel["items"]]
        if populated:
            largest = max(populated, key=lambda channel: len(channel["items"]))
            largest["items"] = largest["items"][1:]
            continue
        if not summaries_dropped:
            summaries_dropped = True
            for channel in channels:
                channel["summary"] = None
            continue
        return message


def _channel_view(channel: Any) -> dict[str, Any]:
    items = channel.items[-MAX_BOARD_ITEMS_PER_CHANNEL:]
    summary = channel.summary
    if summary is not None:
        summary = summary[:MAX_BOARD_SUMMARY_CHARS]
    return {
        "name": channel.name,
        "summary": summary,
        "uncompressed": channel.uncompressed,
        "item_count": len(channel.items),
        "items": [_item_view(item) for item in items],
    }


def _item_view(item: Any) -> dict[str, Any]:
    content = json.dumps(item.content, ensure_ascii=False, separators=(",", ":"))
    truncated = len(content) > MAX_BOARD_CONTENT_CHARS
    view: dict[str, Any] = {
        "seq": item.seq,
        "ts": item.ts,
        "trust": item.trust,
        "priority": item.priority,
        "outcome": item.outcome,
        "refs": list(item.refs),
        "content": content[:MAX_BOARD_CONTENT_CHARS],
    }
    if truncated:
        view["truncated"] = True
    return view
