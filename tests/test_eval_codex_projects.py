from nova_audio_agent.evals.codex_projects import CORPUS, evaluate_project_routing


def test_project_routing_corpus_covers_the_closed_decision_surface() -> None:
    assert len({case.case_id for case in CORPUS}) == len(CORPUS)
    assert {case.expected_tool for case in CORPUS} == {
        "codex__run",
        "codex__project",
        "none",
    }
    assert {case.expected_action for case in CORPUS if case.expected_action} == {
        "list",
        "create",
        "select",
        "sessions",
        "resume",
    }


def test_project_routing_scorer_reports_per_case_mismatches() -> None:
    perfect = {case.case_id: (case.expected_tool, case.expected_action) for case in CORPUS}
    assert evaluate_project_routing(perfect).passed is True

    wrong = dict(perfect)
    wrong["select"] = ("codex__run", None)
    report = evaluate_project_routing(wrong)
    assert report.passed is False
    assert report.matched == len(CORPUS) - 1
    assert report.mismatches[0].case_id == "select"
