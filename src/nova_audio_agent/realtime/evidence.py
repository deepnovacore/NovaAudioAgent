"""Safe, speech-shaped views of Memory evidence for realtime consumers."""

from __future__ import annotations

import math

from nova_audio_agent.memory import CONVERSATION_CHANNEL, MemoryItem
from nova_audio_agent.ports import valid_progress_summary
from nova_audio_agent.realtime.speech_prep import SPEECH_FINAL_LIMIT, prepare_for_speech

_GENERIC_SCALAR_KEYS = (
    "op",
    "state",
    "summary",
    "message",
    "observation",
    "condition",
    "hit",
    "error",
    "brightness_pct",
    "color_temp_kelvin",
    "power",
    "direction",
    "elapsed",
)
_STRUCTURED_EVIDENCE_CHANNELS = frozenset({"ha", "fast_sim", "slow_sim", "autoglm", "cam"})
_UNKNOWN_PROSE_KEYS = ("observation", "summary", "message", "error")
_CODEX_PROGRESS_KEYS = frozenset({"op", "phase", "internal_activity", "elapsed", "summary"})


def final_speech_view(outcome: str, content: object) -> str:
    """Extract a speech-prepared view of a Codex terminal handoff."""
    confirmation = _codex_confirmation_speech(content) if outcome == "ok" else None
    if confirmation is not None:
        return confirmation
    final_message: object = None
    code: object = None
    error: object = None
    stage: object = None
    if type(content) is dict:
        code = content.get("code")
        error = content.get("error")
        stage = content.get("stage")
        result = content.get("result")
        if type(result) is dict:
            final_message = result.get("final_message")
    text: str | None = None
    upstream_truncated = False
    if type(final_message) is dict:
        raw = final_message.get("text")
        if type(raw) is str and raw.strip():
            text = raw
        upstream_truncated = final_message.get("truncated") is True
    if text is None:
        category = (
            code
            if type(code) is str and code
            else error
            if type(error) is str and error
            else "no_final_message"
        )
        if outcome == "failed":
            failure = _codex_startup_failure_speech(category, stage)
            if failure is not None:
                return failure
        if outcome == "refused":
            return f"Codex 未执行，需要选择或修正请求（{category}）"
        return f"Codex 任务未能确认完成（{category}）"
    prepped, clipped = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)
    note = "（结果较长，已截取要点）" if upstream_truncated or clipped else ""
    if outcome == "ok":
        return f"Codex 报告任务完成：{prepped}{note}"
    if outcome == "failed":
        category = f"（{code}）" if type(code) is str and code else ""
        return f"Codex 任务失败{category}：{prepped}{note}"
    return f"Codex 任务结果不确定：{prepped}{note}"


def _codex_confirmation_speech(content: object) -> str | None:
    if type(content) is not dict or content.get("code") != "confirmation_required":
        return None
    action = content.get("action")
    workspace = content.get("workspace")
    session = content.get("session")
    prompt = content.get("confirmation_prompt")
    if (
        type(action) is not str
        or type(workspace) is not str
        or not workspace.strip()
        or len(workspace) > 120
        or type(prompt) is not str
        or len(prompt) > 512
    ):
        return _generic_codex_confirmation_speech()
    if action == "create_workspace":
        expected = {
            f"是否创建工作区“{workspace}”并开始任务？请确认或取消。",
            f"准备创建并切换到工作区{workspace}，请确认或取消。",
        }
    elif action == "reuse_workspace":
        expected = {f"是否使用现有工作区“{workspace}”并开始任务？请确认或取消。"}
    elif action == "select_workspace":
        expected = {f"准备切换到工作区{workspace}，请确认或取消。"}
    elif (
        action == "resume_session"
        and type(session) is str
        and bool(session.strip())
        and len(session) <= 120
    ):
        expected = {f"准备切换到{workspace}，并继续 Session“{session}”，请确认或取消。"}
    else:
        return _generic_codex_confirmation_speech()
    if prompt not in expected:
        return _generic_codex_confirmation_speech()
    return prompt


def _generic_codex_confirmation_speech() -> str:
    return (
        "Codex 有一项项目操作等待你的确认。这项操作尚未执行，Codex 也还没有开始任务。请确认或取消。"
    )


def _codex_startup_failure_speech(category: str, stage: object) -> str | None:
    if category == "credential_missing" or stage == "credential":
        return "Codex 登录凭据不可用，这次任务没有成功启动。"
    if category == "spawn_failed" or stage == "spawn":
        return "Codex 进程未能启动，这次任务没有成功启动。"
    if category in {"thread_id_invalid", "session_thread_mismatch"}:
        return "Codex 会话未能建立，这次任务没有成功启动。"
    if category in {"worker_refused", "server_rejected"}:
        return "Codex 会话启动被拒绝，这次任务没有成功启动。"
    if stage == "preflight":
        return "Codex 启动前检查失败，这次任务没有成功启动。"
    if stage == "thread_start":
        return "Codex 会话启动失败，这次任务没有成功启动。"
    return None


def generic_final_speech_view(display_name: str, outcome: str, content: object) -> str:
    values = content if type(content) is dict else {}
    prose = next(
        (
            value.strip()
            for key in ("observation", "summary", "message")
            if type(value := values.get(key)) is str and value.strip()
        ),
        "",
    )
    if outcome == "ok" and values.get("hit") is True:
        condition = values.get("condition")
        prefix = f"{display_name} 报告命中"
        if type(condition) is str and condition.strip():
            prefix += condition.strip()
        text = f"{prefix}：{prose}" if prose else prefix
    elif outcome == "ok" and values.get("hit") is False:
        text = f"{display_name} 监控结束，未命中条件"
    elif outcome == "ok":
        text = f"{display_name} 报告：{prose}" if prose else f"{display_name} 报告任务完成"
    elif outcome == "failed":
        text = f"{display_name} 任务失败"
    elif outcome == "refused":
        text = f"{display_name} 未执行，需要选择或修正请求"
    else:
        text = f"{display_name} 任务结果不确定"
    error = values.get("error")
    if outcome != "ok" and type(error) is str and error.strip():
        category = prepare_for_speech(error.strip(), limit=80)[0]
        text += f"（{category}）"
    return prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)[0]


def safe_memory_evidence(item: MemoryItem) -> str | None:
    """Project one Memory item without exposing raw provider envelopes or refs."""
    content = item.content if type(item.content) is dict else {}
    outcome = item.outcome or "unknown"

    if item.channel == CONVERSATION_CHANNEL:
        text = content.get("text")
        if type(text) is not str or not text.strip():
            return None
        prepared = prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)[0]
        return prepared or None

    if item.channel == "codex":
        if item.outcome is not None:
            return final_speech_view(outcome, content)
        summary = _stored_codex_progress_summary(item)
        if summary is not None:
            return prepare_for_speech(summary, limit=SPEECH_FINAL_LIMIT)[0] or None
        return final_speech_view(outcome, content)

    if item.channel == "search":
        return _search_evidence(content)

    if item.channel in {"watch", "guard"}:
        filtered = {
            key: content[key] for key in ("condition", "hit", "observation") if key in content
        }
        return generic_final_speech_view(item.channel, outcome, filtered)

    if item.channel not in _STRUCTURED_EVIDENCE_CHANNELS:
        filtered = {key: content[key] for key in _UNKNOWN_PROSE_KEYS if key in content}
        if not filtered:
            return None
        return generic_final_speech_view(item.channel, outcome, filtered)

    fields: list[str] = []
    for key in _GENERIC_SCALAR_KEYS:
        value = content.get(key)
        if type(value) is bool:
            rendered = "true" if value else "false"
        elif type(value) in {str, int, float}:
            rendered = str(value).strip()
        else:
            continue
        if rendered:
            fields.append(f"{key}={rendered}")
    if not fields:
        return None
    return prepare_for_speech(
        f"{item.channel} 报告：{'；'.join(fields)}",
        limit=SPEECH_FINAL_LIMIT,
    )[0]


def _stored_codex_progress_summary(item: MemoryItem) -> str | None:
    content = item.content
    if (
        item.trust != "trusted_system"
        or item.outcome is not None
        or type(content) is not dict
        or set(content) != _CODEX_PROGRESS_KEYS
        or content.get("op") != "run"
        or content.get("phase") != "working"
    ):
        return None
    internal_activity = content.get("internal_activity")
    elapsed = content.get("elapsed")
    summary = content.get("summary")
    if (
        type(internal_activity) is not int
        or not 1 <= internal_activity <= 1_048_576
        or type(elapsed) not in {int, float}
        or not math.isfinite(elapsed)
        or elapsed < 0
        or not valid_progress_summary(summary, phase="working")
        or type(summary) is not str
    ):
        return None
    return summary


def _search_evidence(content: dict[str, object]) -> str | None:
    rendered_results: list[str] = []
    results = content.get("results")
    if type(results) is list:
        for result in results[:3]:
            if type(result) is not dict:
                continue
            title = _prepared_scalar(result.get("title"), 120)
            source = _prepared_scalar(result.get("source_label"), 80)
            snippet = _prepared_scalar(result.get("snippet"), 240)
            head = f"{title}（{source}）" if title and source else title or source
            rendered = f"{head}：{snippet}" if head and snippet else head or snippet
            if rendered:
                rendered_results.append(rendered)
    if not rendered_results:
        return None
    text = f"搜索结果：{'；'.join(rendered_results)}"
    return prepare_for_speech(text, limit=SPEECH_FINAL_LIMIT)[0]


def _prepared_scalar(value: object, limit: int) -> str:
    if type(value) is not str or not value.strip():
        return ""
    return prepare_for_speech(value, limit=limit)[0]
