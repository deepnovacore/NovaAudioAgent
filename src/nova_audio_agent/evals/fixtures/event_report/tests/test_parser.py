"""Acceptance tests for event_report.parser. Do not modify."""

from __future__ import annotations

import unittest

from event_report.parser import Event, EventFormatError, parse_lines, parse_record


class ParseRecordTest(unittest.TestCase):
    def test_accepts_a_well_formed_record(self) -> None:
        record = {"event_id": "e1", "user": "alice", "value": 3}

        self.assertEqual(parse_record(record), Event(event_id="e1", user="alice", value=3))

    def test_accepts_a_zero_value(self) -> None:
        record = {"event_id": "e1", "user": "alice", "value": 0}

        self.assertEqual(parse_record(record).value, 0)

    def test_rejects_a_non_mapping(self) -> None:
        for record in ([], "e1", 7, None):
            with self.subTest(record=record):
                with self.assertRaises(EventFormatError):
                    parse_record(record)

    def test_rejects_missing_and_unexpected_keys(self) -> None:
        missing = {"event_id": "e1", "user": "alice"}
        extra = {"event_id": "e1", "user": "alice", "value": 3, "note": "hi"}

        with self.assertRaises(EventFormatError):
            parse_record(missing)
        with self.assertRaises(EventFormatError):
            parse_record(extra)

    def test_rejects_wrong_field_types(self) -> None:
        for record in (
            {"event_id": 1, "user": "alice", "value": 3},
            {"event_id": "e1", "user": None, "value": 3},
            {"event_id": "e1", "user": "alice", "value": "3"},
            {"event_id": "e1", "user": "alice", "value": True},
        ):
            with self.subTest(record=record):
                with self.assertRaises(EventFormatError):
                    parse_record(record)

    def test_rejects_empty_strings_and_negative_values(self) -> None:
        for record in (
            {"event_id": "", "user": "alice", "value": 3},
            {"event_id": "e1", "user": "", "value": 3},
            {"event_id": "e1", "user": "alice", "value": -1},
        ):
            with self.subTest(record=record):
                with self.assertRaises(EventFormatError):
                    parse_record(record)


class ParseLinesTest(unittest.TestCase):
    def test_skips_blank_lines_and_preserves_order(self) -> None:
        lines = [
            '{"event_id": "e2", "user": "bob", "value": 5}',
            "",
            "   ",
            '{"event_id": "e1", "user": "alice", "value": 3}',
        ]

        self.assertEqual(
            parse_lines(lines),
            [
                Event(event_id="e2", user="bob", value=5),
                Event(event_id="e1", user="alice", value=3),
            ],
        )

    def test_rejects_invalid_json_and_malformed_records(self) -> None:
        with self.assertRaises(EventFormatError):
            parse_lines(["{not json}"])
        with self.assertRaises(EventFormatError):
            parse_lines(['{"event_id": "e1", "user": "alice"}'])


if __name__ == "__main__":
    unittest.main()
