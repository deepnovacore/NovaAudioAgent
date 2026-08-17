"""Score JSON predictions for the fixed Codex project routing corpus."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict

from nova_audio_agent.evals.codex_projects import evaluate_project_routing


def main() -> int:
    raw = json.load(sys.stdin)
    predictions = {
        str(case_id): (str(value.get("tool", "none")), value.get("action"))
        for case_id, value in raw.items()
        if type(value) is dict
    }
    report = evaluate_project_routing(predictions)
    print(json.dumps({
        "passed": report.passed,
        "total": report.total,
        "matched": report.matched,
        "mismatches": [asdict(item) for item in report.mismatches],
    }, ensure_ascii=False))
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
