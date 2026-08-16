# event_report

A tiny, self-contained exercise: turn a JSONL event stream into a deduplicated
per-user report.

This directory is the immutable fixture for the `qwen-codex-live-progress-status.v1`
scenario. A fresh copy is made for every run; the copy is the only thing a worker
may change.

## Layout

```text
event_report/
  __init__.py   public exports
  parser.py     JSONL record parsing and validation
  aggregate.py  event-id deduplication and per-user aggregation
  render.py     deterministic sorted text report
tests/
  test_parser.py
  test_aggregate.py
  test_render.py
```

## Task

Three functions are unimplemented and raise `NotImplementedError`. Each one's
docstring is its specification:

- `parser.parse_record` / `parser.parse_lines` — decode JSONL and reject malformed
  event shapes;
- `aggregate.deduplicate` / `aggregate.aggregate` — drop repeated event ids and
  total each user's events;
- `render.render_report` — render one deterministic, sorted text report.

## Acceptance rules

1. Run the whole suite from this directory with the standard library only:

   ```bash
   python -m unittest
   ```

   All tests must pass.

2. Do not modify anything under `tests/`, and do not modify this README. They are
   the acceptance evidence and are checked independently after the run.

3. Use only the Python standard library. No network access, no new dependency
   manifest, no generated caches counted as deliverables.

4. Keep every change inside this workspace.
