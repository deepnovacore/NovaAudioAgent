"""Python behavioral oracle for project-boundary confirmation.

Normal checks are read-only. Updating the golden requires the explicit ``export`` command so
behavioral changes stay visible in review.

    uv run python scripts/project_confirmation_oracle.py check
    uv run python scripts/project_confirmation_oracle.py export

The controller owns the turn reservation and single-use commit authority. Its sequence of outcomes
over structured ``proposal_id`` plus ``confirmed`` decisions is what stops a confirmation being
replayed, forged, or answered by the wrong utterance.
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT / "src"))

from nova_audio_agent.canonical_json import canonical_json  # noqa: E402
from nova_audio_agent.clock import VirtualClock  # noqa: E402
from nova_audio_agent.realtime.project_confirmation import (  # noqa: E402
    ProjectConfirmationController,
)

FIXTURE = REPOSITORY_ROOT / "fixtures" / "realtime" / "confirmation" / "v1" / "scenarios.json"
EXPECTED = FIXTURE.with_name("scenarios-expected.json")


class FixtureError(RuntimeError):
    """A scenario is malformed."""


def _ids(values: Sequence[str]) -> Any:
    iterator = iter(values)

    def factory() -> str:
        try:
            return next(iterator)
        except StopIteration as error:
            raise FixtureError("proposal ID sequence exhausted") from error

    return factory


async def run_controller(spec: Mapping[str, Any]) -> dict[str, Any]:
    clock = VirtualClock()
    views: list[dict[str, Any]] = []
    expiries: list[int] = []
    controller = ProjectConfirmationController(
        clock=clock,
        id_factory=_ids(
            spec.get("proposal_ids", ["proposal-1", "proposal-2", "proposal-3"])
        ),
        on_change=lambda view: views.append(asdict(view)),
    )
    controller.observe_expiry(lambda: expiries.append(len(views)))

    steps: list[dict[str, Any]] = []
    held: Any = None
    for index, step in enumerate(spec["steps"]):
        kind = step["kind"]
        view_mark = len(views)
        expiry_mark = len(expiries)
        result: Any
        try:
            if kind == "prepare":
                proposal = controller.prepare(
                    action=step["action"],
                    workspace_display_name=step["workspace_display_name"],
                    workspace_id=step.get("workspace_id"),
                    session_title=step.get("session_title"),
                    session_id=step.get("session_id"),
                    work_order=step.get("work_order"),
                    origin_ref=step["origin_ref"],
                )
                result = asdict(proposal)
            elif kind == "reserve":
                result = controller.reserve_user_item(epoch=step["epoch"], item_id=step["item_id"])
            elif kind == "accept":
                out = controller.accept_decision(
                    epoch=step["epoch"],
                    item_id=step["item_id"],
                    proposal_id=step["proposal_id"],
                    confirmed=step["confirmed"],
                )
                if out.operation is not None:
                    held = out.operation
                result = asdict(out)
            elif kind == "fail":
                result = asdict(
                    controller.fail_transcript(epoch=step["epoch"], item_id=step["item_id"])
                )
            elif kind == "claim":
                # Nothing confirmed means there is nothing to claim. Passing `None` through would
                # match the controller's own `None` authority and report success, which is an
                # artefact of this harness rather than behavior -- the one production caller is
                # typed to a real operation.
                result = False if held is None else controller.claim_confirmed(held)
            elif kind == "claim_forged":
                # A reconstructed operation with identical fields must not commit.
                from nova_audio_agent.realtime.project_confirmation import (
                    ConfirmedProjectOperation,
                )

                if held is None:
                    raise FixtureError("claim_forged needs a prior confirmation")
                result = controller.claim_confirmed(ConfirmedProjectOperation(**asdict(held)))
            elif kind == "expire":
                result = controller.expire()
            elif kind == "invalidate":
                result = controller.invalidate(step.get("reason", "test"))
            elif kind == "set_clock":
                # Time moves; nothing scheduled gets a chance to run. Whether a timer would have
                # fired by now is a property of each runtime's loop, so a scenario that let one run
                # would be pinning the harness rather than the controller.
                clock.advance_to(step["to"])
                result = None
            elif kind == "view":
                result = asdict(controller.view)
            else:
                raise FixtureError(f"unsupported step kind: {kind}")
        except (ValueError, TypeError) as error:
            result = {"error": str(error)}

        steps.append(
            {
                "step": index,
                "kind": kind,
                "result": result,
                "views": views[view_mark:],
                "expiry_notifications": len(expiries) - expiry_mark,
                "state": {
                    "pending": controller.pending,
                    "view": asdict(controller.view),
                    "clock": clock.now(),
                },
            }
        )
    return {"name": spec["name"], "steps": steps}


def run_all(document: Mapping[str, Any]) -> dict[str, Any]:
    names = [scenario["name"] for scenario in document["controller"]]
    if len(set(names)) != len(names):
        raise FixtureError("controller scenario names must be unique")
    return {
        "schema_version": 2,
        "controller": [
            asyncio.run(run_controller(scenario)) for scenario in document["controller"]
        ],
    }


def load_document() -> dict[str, Any]:
    document = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if document.get("schema_version") != 2:
        raise FixtureError("unknown confirmation fixture schema version")
    return document


def check() -> int:
    if not EXPECTED.is_file():
        print(f"missing {EXPECTED.name}; run export first", file=sys.stderr)
        return 1
    produced = run_all(load_document())
    committed = json.loads(EXPECTED.read_text(encoding="utf-8"))
    if canonical_json(produced) == canonical_json(committed):
        print(
            f"Python structured confirmation parity passed: "
            f"{len(produced['controller'])} scenario(s)"
        )
        return 0
    print(_diff(committed, produced), file=sys.stderr)
    return 1


def export() -> None:
    produced = run_all(load_document())
    temporary = EXPECTED.with_suffix(".json.tmp")
    temporary.write_text(_pretty(produced) + "\n", encoding="utf-8")
    temporary.replace(EXPECTED)


def _pretty(value: Any, *, sort_keys: bool = False) -> str:
    rendered = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=sort_keys, allow_nan=False)
    return "".join(
        f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in rendered
    )


def _diff(expected: Any, actual: Any) -> str:
    return "\n".join(
        difflib.unified_diff(
            _pretty(expected, sort_keys=True).splitlines(),
            _pretty(actual, sort_keys=True).splitlines(),
            fromfile="scenarios-expected.json",
            tofile="python-actual.json",
            lineterm="",
        )
    )


def main(argv: Sequence[str] | None = None) -> int:
    # Take an explicit argv so an embedding test runner's own arguments cannot leak in.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "export"))
    args = parser.parse_args(argv)
    try:
        if args.command == "export":
            export()
            print(f"exported {EXPECTED.name}")
            return 0
        return check()
    except FixtureError as error:
        print(f"malformed fixture: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
