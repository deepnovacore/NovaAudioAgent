"""JSONL event log + replay.

D14: pure in-memory + append-only JSONL (write-only, no reading back). Its purpose
is **trace replay fuel**, not crash recovery. So this file only does two things:
"write one line" and "read the whole file back as a run of events."

**`replay()` is an event-syntax round trip, not a behavior-level rerun.** It verifies
that "what was written out and what's read back are the same run" — no field
dropped, no type wrong, no seq / ts drifted. It doesn't feed this run of events back
into a `Runtime`, and it doesn't check whether the same follow-up would result — nor
could it: model output, per the hygiene rule below, never enters the trace, and
Floor's reservation runs inside a streaming task and isn't an event at all
(06-verification.md records the reasoning for both).

Serialization uses an **explicit registry** (kind → event type), not reflection:
change the event table and you must change events.EVENT_TYPES, and this file
follows along — missing a kind fails loudly with a KeyError.

One hygiene rule (04-ports.md): model output and prompts never enter the trace. The
ModelDone / CompressDone payloads carry only the slot name and job_id; the actual
artifacts stay in the runtime's job table.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import TracebackType
from typing import Any

from nova_audio_agent.events import EVENT_TYPES, Event

_EVENT_BY_KIND: dict[str, type[Event]] = {event_type.KIND: event_type for event_type in EVENT_TYPES}


def to_record(event: Event) -> dict[str, Any]:
    return {
        "seq": event.seq,
        "ts": event.ts,
        "kind": event.KIND,
        "payload": event.to_payload(),
    }


def from_record(record: dict[str, Any]) -> Event:
    event_type = _EVENT_BY_KIND[record["kind"]]
    return event_type.from_payload(record["payload"], ts=record["ts"], seq=record["seq"])


class TraceWriter:
    """One event per line. Line-buffered, readable as soon as it's written — tests
    don't need an explicit flush.

    **One file = one run**: uses "w", not "a". In append mode, reusing the same
    path would let replay read back the previous run's events too, instantly
    breaking "identical, event by event, to the actual run sequence."

    allow_nan=False: NaN can be written and read back by json, but nan != nan,
    so events would necessarily compare unequal — better to blow up at write time
    than to discover it only when comparing during replay.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._handle = self.path.open("w", encoding="utf-8", buffering=1)

    def write(self, event: Event) -> None:
        line = json.dumps(to_record(event), ensure_ascii=False, sort_keys=True, allow_nan=False)
        self._handle.write(line + "\n")

    def close(self) -> None:
        self._handle.close()

    def __enter__(self) -> TraceWriter:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


def replay(path: Path | str) -> list[Event]:
    """Read a JSONL file back as a run of events. Identical, event by event, to the
    actual run sequence, including ts and seq."""
    text = Path(path).read_text(encoding="utf-8")
    return [from_record(json.loads(line)) for line in text.splitlines() if line.strip()]
