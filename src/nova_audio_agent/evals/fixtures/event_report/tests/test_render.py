"""Acceptance tests for event_report.render. Do not modify."""

from __future__ import annotations

import unittest

from event_report.aggregate import UserTotal
from event_report.render import render_report


class RenderReportTest(unittest.TestCase):
    def test_lists_users_in_sorted_order(self) -> None:
        totals = [
            UserTotal(user="bob", count=1, total=5),
            UserTotal(user="alice", count=2, total=7),
        ]

        self.assertEqual(
            render_report(totals),
            "event report\n"
            "alice: count=2 total=7\n"
            "bob: count=1 total=5\n"
            "total: users=2 events=3 value=12\n",
        )

    def test_summarizes_a_single_user(self) -> None:
        totals = [UserTotal(user="carol", count=3, total=9)]

        self.assertEqual(
            render_report(totals),
            "event report\ncarol: count=3 total=9\ntotal: users=1 events=3 value=9\n",
        )

    def test_no_totals_still_render_a_header_and_summary(self) -> None:
        self.assertEqual(
            render_report([]),
            "event report\ntotal: users=0 events=0 value=0\n",
        )

    def test_report_ends_with_exactly_one_newline(self) -> None:
        report = render_report([UserTotal(user="alice", count=1, total=1)])

        self.assertTrue(report.endswith("\n"))
        self.assertFalse(report.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()
