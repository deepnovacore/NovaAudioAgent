"""Render aggregated totals as one deterministic text report.

Each docstring below is the specification the tests in ``tests/test_render.py``
pin. The tests are acceptance evidence and must not be modified.
"""

from __future__ import annotations

from collections.abc import Iterable

from event_report.aggregate import UserTotal


def render_report(totals: Iterable[UserTotal]) -> str:
    """Render totals as a deterministic report ending in a single newline.

    The first line is always ``event report``. Then comes one line per user, sorted
    by ``user`` ascending regardless of input order::

        <user>: count=<count> total=<total>

    The last line summarizes every rendered user::

        total: users=<users> events=<events> value=<value>

    where ``users`` is the number of user lines, ``events`` is the sum of their
    counts, and ``value`` is the sum of their totals. Rendering no totals therefore
    produces::

        event report
        total: users=0 events=0 value=0

    Lines are joined with ``"\\n"`` and the whole report ends with ``"\\n"``.
    """
    raise NotImplementedError("TODO: render the header, sorted user lines, and the summary")
