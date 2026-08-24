"""Deterministic tool-selection corpus for the compact Codex project surface."""

from __future__ import annotations

import json
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
    expected_arguments: Mapping[str, object] | None = None
    context: str | None = None


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
        "independent",
        "创建一个完整的俄罗斯方块游戏",
        "codex__project",
        {
            "action": "create_workspace",
            "workspace": "俄罗斯方块",
            "session": "初始开发",
            "work_order": "创建一个完整的俄罗斯方块游戏",
        },
    ),
    ProjectRoutingCase(
        "current",
        "在当前项目里修复登录 bug",
        "codex__project",
        {"action": "start_session", "work_order": "在当前项目里修复登录 bug"},
        "<active_project_context>workspace=alpha; session=</active_project_context>",
    ),
    ProjectRoutingCase(
        "history",
        "继续俄罗斯方块项目",
        "codex__project",
        {"action": "list_workspaces"},
    ),
    ProjectRoutingCase(
        "select",
        "候选里就是 alpha，切换进去",
        "codex__project",
        {"action": "select_workspace", "workspace": "alpha"},
        "codex__project list_workspaces 返回候选 workspace：alpha、beta。",
    ),
    ProjectRoutingCase(
        "sessions",
        "列出这个项目的历史 Session",
        "codex__project",
        {"action": "list_sessions", "workspace": "alpha"},
        "codex__project select_workspace 已进入 alpha。",
    ),
    ProjectRoutingCase(
        "resume",
        "继续 Login fix，把登录问题修完",
        "codex__project",
        {
            "action": "resume_session",
            "workspace": "alpha",
            "session": "Login fix",
            "work_order": "继续修复登录问题",
        },
        "已进入 alpha；codex__project list_sessions 返回候选 Session：Login fix、Homepage。",
    ),
    ProjectRoutingCase(
        "confirm-yes",
        "可以，就这样做",
        "codex__confirm_project_action",
        {"proposal_id": "proposal-live", "confirmed": True},
        "当前待确认 proposal_id=proposal-live。",
    ),
    ProjectRoutingCase(
        "confirm-no",
        "先不要切换了",
        "codex__confirm_project_action",
        {"proposal_id": "proposal-live", "confirmed": False},
        "当前待确认 proposal_id=proposal-live。",
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
        tool, arguments = predictions.get(case.case_id, ("none", None))
        expected = _label(case.expected_tool, case.expected_arguments)
        actual = _label(tool, arguments)
        if actual != expected:
            mismatches.append(ProjectRoutingMismatch(case.case_id, expected, actual))
    return ProjectRoutingReport(
        passed=not mismatches,
        total=len(CORPUS),
        matched=len(CORPUS) - len(mismatches),
        mismatches=tuple(mismatches),
    )


def _label(tool: str, arguments: object | None) -> str:
    if tool == "codex__project":
        normalized = _normalize_project_arguments(arguments)
        return f"{tool}:{_canonical(normalized)}" if normalized is not None else f"{tool}:invalid"
    if tool == "codex__confirm_project_action":
        normalized = _normalize_confirmation_arguments(arguments)
        return f"{tool}:{_canonical(normalized)}" if normalized is not None else f"{tool}:invalid"
    if tool == "none" and arguments is None:
        return tool
    return f"{tool}:invalid"


def _normalize_project_arguments(arguments: object) -> dict[str, str] | None:
    if type(arguments) is not dict or not set(arguments).issubset(
        {"action", "workspace", "session", "work_order"}
    ):
        return None
    action = arguments.get("action")
    required = {
        "list_workspaces": {"action"},
        "create_workspace": {"action", "workspace"},
        "select_workspace": {"action", "workspace"},
        "list_sessions": {"action"},
        "start_session": {"action", "work_order"},
        "resume_session": {"action", "work_order"},
    }
    if type(action) is not str or action not in required:
        return None
    allowed = set(required[action])
    if action == "create_workspace":
        allowed.update(("session", "work_order"))
    elif action == "list_sessions":
        allowed.add("workspace")
    elif action == "start_session":
        allowed.add("session")
    elif action == "resume_session":
        allowed.update(("workspace", "session"))
    if set(arguments) - allowed or not required[action].issubset(arguments):
        return None
    if action == "create_workspace" and (
        ("session" in arguments) != ("work_order" in arguments)
    ):
        return None
    normalized = {"action": action}
    for name, limit in (("workspace", 80), ("session", 120), ("work_order", 4000)):
        if name not in arguments:
            continue
        value = arguments[name]
        if type(value) is not str or not value.strip() or len(value) > limit:
            return None
        normalized[name] = value.strip()
    return normalized


def _normalize_confirmation_arguments(arguments: object) -> dict[str, object] | None:
    if type(arguments) is not dict or set(arguments) != {"proposal_id", "confirmed"}:
        return None
    proposal_id = arguments.get("proposal_id")
    confirmed = arguments.get("confirmed")
    if (
        type(proposal_id) is not str
        or not proposal_id.strip()
        or len(proposal_id) > 128
        or type(confirmed) is not bool
    ):
        return None
    return {"proposal_id": proposal_id.strip(), "confirmed": confirmed}


def _canonical(value: Mapping[str, object]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
