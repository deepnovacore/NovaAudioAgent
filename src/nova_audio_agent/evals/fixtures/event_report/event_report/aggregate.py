"""Deduplicate events by id and total them per user.

Each docstring below is the specification the tests in ``tests/test_aggregate.py``
pin. The tests are acceptance evidence and must not be modified.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from event_report.parser import Event


@dataclass(frozen=True)
class UserTotal:
    """One user's deduplicated event count and value total."""

    user: str
    count: int
    total: int


def deduplicate(events: Iterable[Event]) -> list[Event]:
    """Return the events with repeated ``event_id`` values removed.

    The first occurrence of each ``event_id`` wins and input order is preserved.
    A later event that reuses an earlier id is dropped even when its ``user`` or
    ``value`` differ.
    """
    raise NotImplementedError("TODO: keep the first event per id, in order")


def aggregate(events: Iterable[Event]) -> list[UserTotal]:
    """Deduplicate the events, then total them per user.

    Returns one :class:`UserTotal` per distinct user, sorted by ``user`` ascending.
    ``count`` is that user's number of deduplicated events and ``total`` is the sum
    of their ``value`` fields. An empty input returns an empty list.
    """
    raise NotImplementedError("TODO: deduplicate, then total per user in sorted order")
