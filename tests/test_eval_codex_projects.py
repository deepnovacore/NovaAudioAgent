import json
import subprocess
import sys
from pathlib import Path

from nova_audio_agent.evals.codex_projects import CORPUS, evaluate_project_routing


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def perfect_predictions() -> dict[str, tuple[str, object | None]]:
    return {case.case_id: (case.expected_tool, case.expected_arguments) for case in CORPUS}


def test_project_routing_corpus_covers_exact_six_action_arguments_and_stages() -> None:
    assert len({case.case_id for case in CORPUS}) == len(CORPUS)
    assert {case.expected_tool for case in CORPUS} == {
        "codex__project",
        "codex__confirm_project_action",
        "none",
    }
    project_cases = {
        case.expected_arguments["action"]: case
        for case in CORPUS
        if case.expected_tool == "codex__project"
        and case.case_id in {"independent", "current", "history", "select", "sessions", "resume"}
    }
    assert set(project_cases) == {
        "create_workspace",
        "start_session",
        "list_workspaces",
        "list_sessions",
        "select_workspace",
        "resume_session",
    }
    assert project_cases["create_workspace"].expected_arguments == {
        "action": "create_workspace",
        "workspace": "俄罗斯方块",
        "work_order": "创建一个完整的俄罗斯方块游戏",
    }
    assert project_cases["start_session"].expected_arguments == {
        "action": "start_session",
        "work_order": "在当前项目里修复登录 bug",
    }
    assert project_cases["list_workspaces"].context is None
    assert "list_workspaces" in (project_cases["select_workspace"].context or "")
    assert "select_workspace" in (project_cases["list_sessions"].context or "")
    assert "list_sessions" in (project_cases["resume_session"].context or "")
    assert project_cases["select_workspace"].expected_arguments == {
        "action": "select_workspace",
        "workspace": "alpha",
    }
    assert project_cases["resume_session"].expected_arguments == {
        "action": "resume_session",
        "workspace": "alpha",
        "session": "Login fix",
        "work_order": "继续修复登录问题",
    }


def test_project_routing_scorer_accepts_complete_real_action_arguments() -> None:
    report = evaluate_project_routing(perfect_predictions())
    assert report.passed is True
    assert report.matched == len(CORPUS)


def test_project_routing_corpus_covers_elliptical_explicit_and_confirmed_creation() -> None:
    cases = {case.case_id: case for case in CORPUS}
    for case_id in ("elliptical-after-help", "explicit-develop", "clarified-yes"):
        case = cases[case_id]
        assert case.expected_tool == "codex__project"
        assert case.expected_arguments == {
            "action": "create_workspace",
            "workspace": "俄罗斯方块",
            "work_order": "开发一个可运行并经过验证的俄罗斯方块小游戏",
        }
    assert "有什么可以帮你" in (cases["elliptical-after-help"].context or "")
    assert "原始目标" in (cases["clarified-yes"].context or "")
    assert cases["material-choice-missing"].expected_tool == "none"


def test_project_routing_corpus_preserves_an_explicit_new_session_title() -> None:
    case = next(item for item in CORPUS if item.case_id == "independent-named-session")

    assert case.utterance == "创建 alpha 工作区，并新建一个叫初始开发的 Session 来完成登录页"
    assert case.expected_tool == "codex__project"
    assert case.expected_arguments == {
        "action": "create_workspace",
        "workspace": "alpha",
        "session": "初始开发",
        "work_order": "在 alpha 工作区完成并验证登录页",
    }


def test_project_routing_rejects_extra_missing_null_and_wrong_action_values() -> None:
    perfect = perfect_predictions()
    project_cases = [case for case in CORPUS if case.expected_tool == "codex__project"]
    for case in project_cases:
        expected = dict(case.expected_arguments)
        adversarial = (
            {**expected, "extra": "forbidden"},
            {key: value for key, value in expected.items() if key != "action"},
            {**expected, "action": None},
            {
                **expected,
                "action": (
                    "list_workspaces"
                    if expected["action"] != "list_workspaces"
                    else "list_sessions"
                ),
            },
        )
        for payload in adversarial:
            wrong = dict(perfect)
            wrong[case.case_id] = ("codex__project", payload)
            report = evaluate_project_routing(wrong)
            assert report.passed is False
            assert report.mismatches[0].case_id == case.case_id

    for case_id, payload in (
        (
            "independent",
            {"action": "create_workspace", "workspace": "俄罗斯方块", "session": "初始开发"},
        ),
        ("current", {"action": "start_session", "work_order": None}),
        ("select", {"action": "select_workspace"}),
        ("sessions", {"action": "list_sessions", "workspace": None}),
        (
            "resume",
            {"action": "resume_session", "workspace": "alpha", "session": "Login fix"},
        ),
        (
            "resume",
            {
                "action": "resume_session",
                "workspace": "alpha",
                "session": None,
                "work_order": "继续修复登录问题",
            },
        ),
    ):
        wrong = dict(perfect)
        wrong[case_id] = ("codex__project", payload)
        assert evaluate_project_routing(wrong).passed is False


def test_project_routing_scores_every_string_argument_by_exact_value() -> None:
    perfect = perfect_predictions()
    for case in CORPUS:
        if case.expected_tool != "codex__project":
            continue
        for field, value in case.expected_arguments.items():
            if field == "action" or type(value) is not str:
                continue
            altered = dict(case.expected_arguments)
            altered[field] = f" {value} "
            wrong = dict(perfect)
            wrong[case.case_id] = ("codex__project", altered)
            report = evaluate_project_routing(wrong)
            assert report.passed is False, (case.case_id, field)


def test_project_routing_scores_confirmation_by_structured_id_and_native_boolean() -> None:
    perfect = perfect_predictions()
    for malformed in (
        {"proposal_id": "proposal-live", "confirmed": "yes"},
        {"proposal_id": "proposal-stale", "confirmed": True},
        {"proposal_id": "proposal-live", "confirmed": True, "spoken": "确认"},
        {"proposal_id": None, "confirmed": True},
        {"proposal_id": "proposal-live"},
    ):
        wrong = dict(perfect)
        wrong["confirm-yes"] = ("codex__confirm_project_action", malformed)
        report = evaluate_project_routing(wrong)
        assert report.passed is False
        assert report.mismatches[0].case_id == "confirm-yes"

    whitespace_id = dict(perfect)
    whitespace_id["confirm-yes"] = (
        "codex__confirm_project_action",
        {"proposal_id": " proposal-live ", "confirmed": True},
    )
    assert evaluate_project_routing(whitespace_id).passed is False


def test_eval_codex_projects_cli_forwards_complete_tool_arguments() -> None:
    predictions = {
        case.case_id: {
            "tool": case.expected_tool,
            "arguments": case.expected_arguments,
        }
        for case in CORPUS
    }
    process = subprocess.run(
        [sys.executable, "scripts/eval_codex_projects.py"],
        cwd=REPOSITORY_ROOT,
        input=json.dumps(predictions, ensure_ascii=False),
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert process.returncode == 0, process.stdout + process.stderr
    assert json.loads(process.stdout) == {
        "passed": True,
        "total": len(CORPUS),
        "matched": len(CORPUS),
        "mismatches": [],
    }
