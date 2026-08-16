"""Parse JSONL event records into validated :class:`Event` values.

Each docstring below is the specification the tests in ``tests/test_parser.py``
pin. The tests are acceptance evidence and must not be modified.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


class EventFormatError(ValueError):
    """Raised when a record is not a well-formed event."""


@dataclass(frozen=True)
class Event:
    """One accepted event record."""

    event_id: str
    user: str
    value: int


def parse_record(record: object) -> Event:
    """Validate one already-decoded JSON record and return the matching event.

    A valid record is a ``dict`` whose keys are exactly ``event_id``, ``user`` and
    ``value``, where:

    - ``event_id`` is a non-empty ``str``;
    - ``user`` is a non-empty ``str``;
    - ``value`` is an ``int`` that is not a ``bool`` and is not negative.

    Anything else — a non-mapping, a missing key, an unexpected extra key, a wrong
    type, an empty string, or a negative value — raises :class:`EventFormatError`.
    """
    raise NotImplementedError("TODO: validate the record shape and build an Event")


def parse_lines(lines: Iterable[str]) -> list[Event]:
    """Parse a JSONL stream into events, preserving input order.

    Lines that are empty or whitespace-only are skipped. Every other line is
    decoded with ``json.loads`` and passed to :func:`parse_record`. A line that is
    not valid JSON raises :class:`EventFormatError`.
    """
    raise NotImplementedError("TODO: decode each non-blank line and parse it")
