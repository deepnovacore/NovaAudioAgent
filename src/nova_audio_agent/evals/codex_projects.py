"""Deterministic tool-selection corpus for the compact Codex project surface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping

ExpectedTool = Literal["codex__project", "codex__confirm_project_action", "none"]
PROJECT_ACTIONS = frozenset(
    {
        "create_workspace",
        "start_session",
        "list_workspaces",
        "list_sessions",
        "select_workspace",
        "resume_session",
    }
)


@dataclass(frozen=True, slots=True)
class ProjectRoutingCase:
    case_id: str
    utterance: str
    expected_tool: ExpectedTool
    expected_action: str | None = None
    expected_proposal_id: str | None = None
    expected_confirmed: bool | None = None

    @property
    def expected_payload(self) -> Mapping[str, object] | None:
        if self.expected_tool == "codex__project":
            return {"action": self.expected_action}
        if self.expected_tool == "codex__confirm_project_action":
            return {
                "proposal_id": self.expected_proposal_id,
                "confirmed": self.expected_confirmed,
            }
        return None


@dataclass(frozen=True, slots=True)
class ProjectRoutingMismatch:
    case_id: str
    expected: str
    actual: str


@dataclass(frozen=True, slots=True)
class ProjectRoutingReport:
    passed: bool
    total: int
    matched: int
    mismatches: tuple[ProjectRoutingMismatch, ...]


CORPUS = (
    ProjectRoutingCase(
        "independent", "创建一个完整的俄罗斯方块游戏", "codex__project", "create_workspace"
    ),
    ProjectRoutingCase(
        "current", "在当前项目里修复登录 bug", "codex__project", "start_session"
    ),
    ProjectRoutingCase(
        "history", "继续俄罗斯方块项目", "codex__project", "list_workspaces"
    ),
    ProjectRoutingCase(
        "sessions", "列出 alpha 的历史 Session", "codex__project", "list_sessions"
    ),
    ProjectRoutingCase("select", "切换到 alpha", "codex__project", "select_workspace"),
    ProjectRoutingCase(
        "resume", "继续 alpha 里的 Login fix", "codex__project", "resume_session"
    ),
    ProjectRoutingCase(
        "confirm-yes",
        "可以，就这样做",
        "codex__confirm_project_action",
        expected_proposal_id="proposal-live",
        expected_confirmed=True,
    ),
    ProjectRoutingCase(
        "confirm-no",
        "先不要切换了",
        "codex__confirm_project_action",
        expected_proposal_id="proposal-live",
        expected_confirmed=False,
    ),
    ProjectRoutingCase("ambiguous", "换个项目吧", "none"),
    ProjectRoutingCase("negated", "不要切换工作区", "none"),
    ProjectRoutingCase("unrelated", "今天天气怎么样", "none"),
)


def evaluate_project_routing(
    predictions: Mapping[str, tuple[str, object | None]],
) -> ProjectRoutingReport:
    mismatches: list[ProjectRoutingMismatch] = []
    for case in CORPUS:
        tool, payload = predictions.get(case.case_id, ("none", None))
        expected = _label(case.expected_tool, case.expected_payload)
        actual = _label(tool, payload)
        if actual != expected:
            mismatches.append(ProjectRoutingMismatch(case.case_id, expected, actual))
    return ProjectRoutingReport(
        passed=not mismatches,
        total=len(CORPUS),
        matched=len(CORPUS) - len(mismatches),
        mismatches=tuple(mismatches),
    )


def _label(tool: str, payload: object | None) -> str:
    if tool == "codex__project":
        if type(payload) is not dict or set(payload) != {"action"}:
            return f"{tool}:invalid"
        action = payload.get("action")
        if type(action) is not str or action not in PROJECT_ACTIONS:
            return f"{tool}:invalid"
        return f"{tool}:{action}"
    if tool == "codex__confirm_project_action":
        if type(payload) is not dict or set(payload) != {"proposal_id", "confirmed"}:
            return f"{tool}:invalid"
        proposal_id = payload.get("proposal_id")
        confirmed = payload.get("confirmed")
        if type(proposal_id) is not str or not proposal_id or type(confirmed) is not bool:
            return f"{tool}:invalid"
        return f"{tool}:{proposal_id}:{str(confirmed).lower()}"
    if tool == "none" and payload is None:
        return tool
    return f"{tool}:invalid"
