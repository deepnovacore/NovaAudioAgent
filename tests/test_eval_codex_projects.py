from nova_audio_agent.evals.codex_projects import CORPUS, evaluate_project_routing


def test_project_routing_corpus_covers_the_closed_decision_surface() -> None:
    assert len({case.case_id for case in CORPUS}) == len(CORPUS)
    assert {case.expected_tool for case in CORPUS} == {
        "codex__project",
        "codex__confirm_project_action",
        "none",
    }
    assert {case.expected_action for case in CORPUS if case.expected_action} == {
        "create_workspace",
        "start_session",
        "list_workspaces",
        "list_sessions",
        "select_workspace",
        "resume_session",
    }


def test_project_routing_scorer_reports_per_case_mismatches() -> None:
    perfect = {case.case_id: (case.expected_tool, case.expected_payload) for case in CORPUS}
    assert evaluate_project_routing(perfect).passed is True

    wrong = dict(perfect)
    wrong["select"] = ("codex__project", {"action": "start_session"})
    report = evaluate_project_routing(wrong)
    assert report.passed is False
    assert report.matched == len(CORPUS) - 1
    assert report.mismatches[0].case_id == "select"


def test_project_routing_scores_confirmation_by_structured_id_and_boolean() -> None:
    perfect = {case.case_id: (case.expected_tool, case.expected_payload) for case in CORPUS}
    assert evaluate_project_routing(perfect).passed is True

    for malformed in (
        {"proposal_id": "proposal-live", "confirmed": "yes"},
        {"proposal_id": "proposal-stale", "confirmed": True},
        {"proposal_id": "proposal-live", "confirmed": True, "spoken": "确认"},
    ):
        wrong = dict(perfect)
        wrong["confirm-yes"] = ("codex__confirm_project_action", malformed)
        report = evaluate_project_routing(wrong)
        assert report.passed is False
        assert report.mismatches[0].case_id == "confirm-yes"
