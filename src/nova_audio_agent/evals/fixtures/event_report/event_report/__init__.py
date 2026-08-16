"""A small JSONL event reporting package.

The three modules form one pipeline: :mod:`parser` validates raw records,
:mod:`aggregate` deduplicates and totals them, and :mod:`render` turns the totals
into a deterministic text report.
"""

from __future__ import annotations

from event_report.aggregate import UserTotal, aggregate, deduplicate
from event_report.parser import Event, EventFormatError, parse_lines, parse_record
from event_report.render import render_report

__all__ = [
    "Event",
    "EventFormatError",
    "UserTotal",
    "aggregate",
    "deduplicate",
    "parse_lines",
    "parse_record",
    "render_report",
]
