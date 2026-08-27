"""Shared schema and admission contract for the multiplexed Codex project tool."""

from __future__ import annotations

from typing import Any

from nova_audio_agent.ports import OpSpec


_PROJECT_FIELDS = {
    "workspace": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "description": "create/select 必填；list_sessions/resume 可选；start_session 必须省略",
    },
    "session": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": (
            "用户显式命名新 Session 时必须传入；未命名的新 Session 可省略；"
            "resume_session 指定历史 Session 时传入"
        ),
    },
    "work_order": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "start_session 和 resume_session 必填；create_workspace 可选",
    },
}


def _project_variant(
    action: str,
    fields: tuple[str, ...],
    required: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": [action]},
            **{name: _PROJECT_FIELDS[name] for name in fields},
        },
        "required": ["action", *required],
        "additionalProperties": False,
    }


PROJECT = OpSpec(
    name="project",
    description=(
        "管理 Workspace 和 Session。严格按 action 选择字段：start_session 只能在当前 "
        "Workspace 运行且不得传 workspace；start_session 和 resume_session 都必须传完整 "
        "work_order。用户显式命名新 Session 时必须传 session。"
    ),
    params={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "list_workspaces",
                    "create_workspace",
                    "select_workspace",
                    "list_sessions",
                    "start_session",
                    "resume_session",
                ],
            },
            **_PROJECT_FIELDS,
        },
        "required": ["action"],
        "additionalProperties": False,
        "oneOf": [
            _project_variant("list_workspaces", ()),
            _project_variant("create_workspace", ("workspace",), ("workspace",)),
            _project_variant(
                "create_workspace",
                ("workspace", "session", "work_order"),
                ("workspace", "work_order"),
            ),
            _project_variant("select_workspace", ("workspace",), ("workspace",)),
            _project_variant("list_sessions", ("workspace",)),
            _project_variant("start_session", ("session", "work_order"), ("work_order",)),
            _project_variant(
                "resume_session",
                ("workspace", "session", "work_order"),
                ("work_order",),
            ),
        ],
    },
    readonly=False,
    deadline_budget=600.0,
    sensitive_params=("work_order",),
)

# Compatibility for importers that predate the project tool consolidation.
PROJECT_RUN = PROJECT


def normalize_project_request(request: object) -> dict[str, str] | None:
    """Validate one project action and return its normalized closed shape."""
    if type(request) is not dict or not set(request).issubset(
        {"action", "workspace", "session", "work_order"}
    ):
        return None
    action = request.get("action")
    expected = {
        "list_workspaces": {"action"},
        "create_workspace": {"action", "workspace"},
        "select_workspace": {"action", "workspace"},
        "list_sessions": {"action"},
        "start_session": {"action", "work_order"},
        "resume_session": {"action", "work_order"},
    }
    if action not in expected:
        return None
    allowed = set(expected[action])
    if action == "create_workspace":
        allowed.update(("session", "work_order"))
    elif action == "list_sessions":
        allowed.add("workspace")
    elif action == "start_session":
        allowed.add("session")
    elif action == "resume_session":
        allowed.update(("workspace", "session"))
    if set(request) - allowed or not expected[action].issubset(request):
        return None
    if action == "create_workspace" and ("session" in request and "work_order" not in request):
        return None
    result = {"action": action}
    for name, limit in (
        ("workspace", 80),
        ("session", 120),
        ("work_order", 4000),
    ):
        if name not in request:
            continue
        value = request[name]
        if type(value) is not str or not value.strip() or len(value) > limit:
            return None
        result[name] = value.strip()
    return result
