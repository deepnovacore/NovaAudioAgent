"""Deterministic tool-selection corpus for the compact Codex project surface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping

ExpectedTool = Literal["codex__run", "codex__project", "none"]


@dataclass(frozen=True, slots=True)
class ProjectRoutingCase:
    case_id: str
    utterance: str
    expected_tool: ExpectedTool
    expected_action: str | None = None


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
    ProjectRoutingCase("new-work", "帮我修复当前项目的登录 bug", "codex__run"),
    ProjectRoutingCase("list", "有哪些工作区", "codex__project", "list"),
    ProjectRoutingCase("create", "创建工作区 alpha", "codex__project", "create"),
    ProjectRoutingCase("create-work", "创建工作区 beta 并实现首页", "codex__project", "create"),
    ProjectRoutingCase("select", "切换到 alpha", "codex__project", "select"),
    ProjectRoutingCase("sessions", "列出 alpha 的 Session", "codex__project", "sessions"),
    ProjectRoutingCase(
        "resume", "继续 alpha 里的 Task 1，修完剩余测试", "codex__project", "resume"
    ),
    ProjectRoutingCase("ambiguous", "换个项目吧", "none"),
    ProjectRoutingCase("negated", "不要切换工作区", "none"),
    ProjectRoutingCase("unrelated", "今天天气怎么样", "none"),
)


def evaluate_project_routing(
    predictions: Mapping[str, tuple[str, str | None]],
) -> ProjectRoutingReport:
    mismatches: list[ProjectRoutingMismatch] = []
    for case in CORPUS:
        tool, action = predictions.get(case.case_id, ("none", None))
        expected = _label(case.expected_tool, case.expected_action)
        actual = _label(tool, action)
        if actual != expected:
            mismatches.append(ProjectRoutingMismatch(case.case_id, expected, actual))
    return ProjectRoutingReport(
        passed=not mismatches,
        total=len(CORPUS),
        matched=len(CORPUS) - len(mismatches),
        mismatches=tuple(mismatches),
    )


def _label(tool: str, action: str | None) -> str:
    if tool == "codex__project":
        return f"{tool}:{action or 'missing'}"
    return tool
