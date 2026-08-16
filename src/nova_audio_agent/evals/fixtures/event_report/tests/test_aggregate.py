"""Acceptance tests for event_report.aggregate. Do not modify."""

from __future__ import annotations

import unittest

from event_report.aggregate import UserTotal, aggregate, deduplicate
from event_report.parser import Event


def event(event_id: str, user: str, value: int) -> Event:
    return Event(event_id=event_id, user=user, value=value)


class DeduplicateTest(unittest.TestCase):
    def test_keeps_the_first_event_per_id(self) -> None:
        events = [
            event("e1", "alice", 3),
            event("e1", "bob", 99),
            event("e2", "bob", 5),
        ]

        self.assertEqual(
            deduplicate(events),
            [event("e1", "alice", 3), event("e2", "bob", 5)],
        )

    def test_passes_unique_events_through_in_order(self) -> None:
        events = [event("e2", "bob", 5), event("e1", "alice", 3)]

        self.assertEqual(deduplicate(events), events)


class AggregateTest(unittest.TestCase):
    def test_totals_each_user(self) -> None:
        events = [
            event("e1", "alice", 3),
            event("e2", "alice", 4),
            event("e3", "bob", 5),
        ]

        self.assertEqual(
            aggregate(events),
            [
                UserTotal(user="alice", count=2, total=7),
                UserTotal(user="bob", count=1, total=5),
            ],
        )

    def test_ignores_duplicate_ids_and_sorts_users_ascending(self) -> None:
        events = [
            event("e1", "carol", 2),
            event("e2", "alice", 3),
            event("e2", "alice", 100),
            event("e3", "bob", 5),
        ]

        self.assertEqual(
            aggregate(events),
            [
                UserTotal(user="alice", count=1, total=3),
                UserTotal(user="bob", count=1, total=5),
                UserTotal(user="carol", count=1, total=2),
            ],
        )

    def test_no_events_aggregate_to_nothing(self) -> None:
        self.assertEqual(aggregate([]), [])


if __name__ == "__main__":
    unittest.main()
