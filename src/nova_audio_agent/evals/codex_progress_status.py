"""Scenario definition, recorder, and evaluator for ``qwen-codex-live-progress-status.v1``.

One scenario drives two backends through the same normalized records and the same
gates: the deterministic CI test (``tests/test_e2e_codex_progress_status.py``) and the
explicitly-invoked live command (``scripts/eval_codex_progress_status.py``). Only Gate 6
is backend-specific; ``live=False`` skips it.

The deciding behavior is not that a progress event exists. The projected summary must
carry useful task information, survive the protocol, sanitizer, Memory, and realtime
session boundaries, and ground a natural answer to the status question *while the
delegate is still running*. So the evaluator judges ordering, cardinality, and text —
never a particular sentence, and never with another model as judge.
"""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.ports import valid_progress_summary
from nova_audio_agent.realtime.speech_prep import SPEECH_FINAL_LIMIT, prepare_for_speech

SCENARIO_ID = "qwen-codex-live-progress-status.v1"

STATUS_QUESTION = "现在做到哪了？"

#: The fixed work order. The narration sentence is a deliberate, documented prompt: the
#: behavior under test is the projection -> sanitizer -> Memory -> session -> answer
#: pipeline, not Codex's spontaneous narration habits. A run where the worker still
#: never narrates is classified separately (see :func:`failure_reason`).
WORK_ORDER = (
    "完成 event_report 包中的 TODO，使全部测试通过（`python -m unittest`）；不要修改测试。"
    "先检查现有实现，再逐步实现并运行测试，过程中简要说明你正在做的步骤，最后汇报改动和验证结果。"
)

CODEX_RUN_TOOL_NAME = "codex__run"

_RECORD_FIELDS: dict[str, frozenset[str]] = {
    "user.turn": frozenset({"text"}),
    "tool.call": frozenset({"call_id", "name", "work_order"}),
    "tool.accepted": frozenset({"call_id", "delegate_id", "state"}),
    "delegate.running": frozenset({"delegate_id"}),
    "codex.progress": frozenset({"delegate_id", "phase", "internal_activity", "summary"}),
    # The summary as Runtime Memory actually stored it, read back from the codex channel.
    "memory.progress": frozenset({"phase", "internal_activity", "summary"}),
    "progress.fact": frozenset({"event_id", "content"}),
    "progress.response.terminal": frozenset({"response_id", "status"}),
    "status.question": frozenset({"text"}),
    "status.transcript": frozenset({"response_id", "text"}),
    "codex.handoff": frozenset({"delegate_id", "outcome"}),
    "final.fact": frozenset({"event_id", "content"}),
    "final.response.terminal": frozenset({"response_id", "status"}),
    "audio.delta": frozenset({"response_id", "bytes"}),
    "fixture.gate": frozenset({"name", "passed"}),
}

#: Closed semantic set of fixture-relevant concepts. Deliberately small and fixed: the
#: gate proves the summary said something about *this* task, not that it reads well.
INFORMATIVE_CONCEPTS: tuple[str, ...] = (
    "event report",
    "event_report",
    "JSONL",
    "parser",
    "parse",
    "解析",
    "aggregate",
    "aggregation",
    "聚合",
    "deduplicate",
    "去重",
    "render",
    "report",
    "报告",
    "test",
    "tests",
    "测试",
    "tetris",
    "俄罗斯方块",
    "方块",
    "engine",
    "引擎",
    "board",
    "棋盘",
    "piece",
    "level",
    "等级",
    "drop",
    "下落",
    "lock",
    "锁定",
    "smoke",
)

#: Too easy to hit incidentally ("正在跑测试"). A summary counts as informative only if
#: it also carries a concept from outside this subset.
WEAK_CONCEPTS: frozenset[str] = frozenset(
    {
        "event report",
        "event_report",
        "report",
        "报告",
        "test",
        "tests",
        "测试",
        "tetris",
        "俄罗斯方块",
        "方块",
    }
)

#: Default Gate 6 checks for the deterministic event_report backend. A live runner
#: supplies the independently checked artifact gates for its own contracted fixture.
REQUIRED_FIXTURE_GATES: frozenset[str] = frozenset(
    {
        "tests_unchanged",
        "readme_unchanged",
        "changes_within_workspace",
        "harness_test_command_passed",
    }
)

_ACK_COMPLETION_CLAIMS = ("任务完成", "已经完成", "已完成", "完成了", "做好了", "done")
_STANDALONE_ACK_COMPLETION = re.compile(
    r"(?:^|[\s，。！？、；：,.!?;:])完成(?=$|[\s，。！？、；：,.!?;:])"
)


_COMPLETION_CLAIMS = ("完成了", "已完成", "做完了", "全部通过", "都通过了", "已经完成")

#: Never allowed in a stored or spoken progress form: raw reasoning, command output,
#: absolute paths, credentials, or a protocol envelope.
_FORBIDDEN_PROGRESS_SUBSTRINGS = (
    "/Users/",
    "/private/",
    "/home/",
    "/tmp/",
    "/var/folders/",
    "```",
    "phase=",
    "internal_activity",
    "elapsed=",
    "sha256",
    "exit_code",
    "function_call_output",
    "nova_progress_event",
    "nova_final_event",
    "-----BEGIN",
)

#: Additionally forbidden in a spoken status answer: protocol vocabulary and identifiers
#: a person would never say out loud.
_FORBIDDEN_STATUS_SUBSTRINGS = (
    *_FORBIDDEN_PROGRESS_SUBSTRINGS,
    "phase",
    "elapsed",
    "delegate_id",
    "event_id",
    "call_id",
    "response_id",
    "outcome",
    "work_order",
)

_SECRET_PATTERN = re.compile(r"(?i)(?:sk|rk|pk)-[A-Za-z0-9_./+=-]{8,}")
_SHELL_PROMPT_PATTERN = re.compile(r"(?:^|\s)(?:\$|>>>|&&)\s")
_SPOKEN_PROTOCOL_MARKERS = ("<nova_", "</nova_", "provenance=")

#: Filler a status answer may contain but must not consist of.
_GENERIC_FILLER = (
    "还在运行",
    "正在运行",
    "还在处理",
    "正在处理",
    "处理中",
    "请稍等",
    "稍等一下",
    "稍等",
    "马上就好",
    "还在跑",
    "在进行中",
    "进行中",
    "好的",
    "嗯",
)
_GENERIC_RESIDUE_CHARS = 6

_PUNCTUATION = re.compile(r"[\s，。！？、；：,.!?;:~…\-—()（）\"'“”‘’]+")

GATE_DISPATCH = "gate1_dispatch_acknowledgement"
GATE_PROJECTION = "gate2_real_intermediate_projection"
GATE_STATUS_TIMING = "gate3_status_question_during_execution"
GATE_STATUS_ANSWER = "gate4_informative_status_answer"
GATE_FINAL_DELIVERY = "gate5_final_delivery_separation"
GATE_FIXTURE_VERIFICATION = "gate6_independent_fixture_verification"

#: Failure codes that a counts-only summary legitimately cascades into. A run whose whole
#: failure set fits inside this is attributed to worker narration, not to the pipeline.
_NARRATION_CASCADE: frozenset[str] = frozenset(
    {
        "progress_summary_not_informative",
        "selected_progress_not_informative",
        "status_answer_not_grounded",
        "status_answer_generic_only",
    }
)


class ScenarioTimeout(RuntimeError):
    """A scenario step never observed the record it was waiting for."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class Finding:
    code: str
    event_ref: str | None
    detail: str


@dataclass(frozen=True, slots=True)
class GateResult:
    name: str
    passed: bool
    findings: tuple[Finding, ...]


@dataclass(frozen=True, slots=True)
class ScenarioReport:
    findings: tuple[Finding, ...]
    gates: tuple[GateResult, ...]
    metrics: Mapping[str, Any]

    @property
    def passed(self) -> bool:
        return not self.findings

    @property
    def first_failed_gate(self) -> str | None:
        for gate in self.gates:
            if not gate.passed:
                return gate.name
        return None


class ScenarioRecorder:
    """Store only the scenario allowlist with synthetic, monotone references.

    The recorder is the redaction boundary, so an artifact can never carry a field
    the evaluator does not read.
    """

    def __init__(self, *, clock: Clock | None = None) -> None:
        self._clock = clock or RealClock()
        self._started = self._clock.now()
        self._records: list[dict[str, Any]] = []
        self._changed = asyncio.Event()

    @property
    def records(self) -> tuple[Mapping[str, Any], ...]:
        return tuple(self._records)

    def now(self) -> float:
        return self._clock.now()

    def record(self, kind: str, data: Mapping[str, Any]) -> dict[str, Any]:
        allowed = _RECORD_FIELDS.get(kind)
        if allowed is None:
            raise ValueError("unsupported scenario event")
        sanitized = {key: data[key] for key in allowed if key in data and _safe_scalar(data[key])}
        record = {
            "event_ref": f"e{len(self._records) + 1:03d}",
            "t_ms": max(0.0, (self.now() - self._started) * 1000.0),
            "kind": kind,
            "data": sanitized,
        }
        self._records.append(record)
        self._changed.set()
        return record

    async def wait_for(
        self,
        kind: str,
        predicate: Callable[[Mapping[str, Any]], bool] | None = None,
        *,
        timeout: float,
        after_event_ref: str | None = None,
    ) -> Mapping[str, Any]:
        async def wait() -> Mapping[str, Any]:
            while True:
                self._changed.clear()
                after_seen = after_event_ref is None
                for record in self._records:
                    if not after_seen:
                        if record["event_ref"] == after_event_ref:
                            after_seen = True
                        continue
                    if record["kind"] != kind:
                        continue
                    if predicate is None or predicate(record):
                        return record
                await self._changed.wait()

        try:
            async with asyncio.timeout(timeout):
                return await wait()
        except TimeoutError:
            raise ScenarioTimeout(f"codex_progress_status_timeout:{kind}") from None


def _safe_scalar(value: object) -> bool:
    if type(value) is str:
        return len(value) <= 4000 and all(char.isprintable() for char in value)
    if type(value) is bool:
        return True
    if type(value) is int:
        return 0 <= value <= 1_048_576
    if type(value) is float:
        return math.isfinite(value) and value >= 0
    return False


def _data(record: Mapping[str, Any]) -> Mapping[str, Any]:
    value = record.get("data")
    return value if isinstance(value, Mapping) else {}


def _events(records: Sequence[Mapping[str, Any]], kind: str) -> list[tuple[int, Mapping[str, Any]]]:
    return [(index, record) for index, record in enumerate(records) if record.get("kind") == kind]


def _finding(code: str, record: Mapping[str, Any] | None, detail: str) -> Finding:
    event_ref = record.get("event_ref") if record is not None else None
    return Finding(
        code=code,
        event_ref=event_ref if isinstance(event_ref, str) else None,
        detail=detail,
    )


def _gate(name: str, findings: Sequence[Finding]) -> GateResult:
    return GateResult(name=name, passed=not findings, findings=tuple(findings))


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def concepts_in(text: str) -> frozenset[str]:
    """Return the closed-set concepts a text mentions, matched case-insensitively."""
    lowered = text.lower()
    return frozenset(concept for concept in INFORMATIVE_CONCEPTS if concept.lower() in lowered)


def is_informative(text: str) -> bool:
    """True when the text carries at least one non-generic fixture concept.

    ``test``/``tests``/``测试`` never suffice alone: "正在跑测试" says nothing about this
    task that "正在跑测试" would not say about any task.
    """
    return bool(concepts_in(text) - WEAK_CONCEPTS)


def _forbidden_hits(text: str, substrings: Sequence[str]) -> tuple[str, ...]:
    hits = [needle for needle in substrings if needle in text]
    if _SECRET_PATTERN.search(text):
        hits.append("credential_pattern")
    return tuple(sorted(set(hits)))


def _normalized(text: str) -> str:
    return _PUNCTUATION.sub("", text)


def _is_generic_only(text: str) -> bool:
    residue = _normalized(text)
    for filler in _GENERIC_FILLER:
        residue = residue.replace(filler, "")
    return len(residue) < _GENERIC_RESIDUE_CHARS


@dataclass(frozen=True, slots=True)
class _Timeline:
    """Every allowlisted record group plus the indices the ordering gates compare."""

    items: tuple[Mapping[str, Any], ...]
    accepted: tuple[tuple[int, Mapping[str, Any]], ...]
    calls: tuple[tuple[int, Mapping[str, Any]], ...]
    running: tuple[tuple[int, Mapping[str, Any]], ...]
    progress: tuple[tuple[int, Mapping[str, Any]], ...]
    memory_progress: tuple[tuple[int, Mapping[str, Any]], ...]
    progress_facts: tuple[tuple[int, Mapping[str, Any]], ...]
    progress_terminals: tuple[tuple[int, Mapping[str, Any]], ...]
    questions: tuple[tuple[int, Mapping[str, Any]], ...]
    transcripts: tuple[tuple[int, Mapping[str, Any]], ...]
    handoffs: tuple[tuple[int, Mapping[str, Any]], ...]
    final_facts: tuple[tuple[int, Mapping[str, Any]], ...]
    final_terminals: tuple[tuple[int, Mapping[str, Any]], ...]
    audio: tuple[tuple[int, Mapping[str, Any]], ...]
    fixture_gates: tuple[tuple[int, Mapping[str, Any]], ...]

    @property
    def end(self) -> int:
        return len(self.items)

    @property
    def question_index(self) -> int | None:
        return self.questions[0][0] if self.questions else None

    @property
    def accepted_runs(self) -> tuple[tuple[int, Mapping[str, Any]], ...]:
        run_call_ids = {
            _data(record).get("call_id")
            for _index, record in self.calls
            if _data(record).get("name") == CODEX_RUN_TOOL_NAME
        }
        return tuple(
            (index, record)
            for index, record in self.accepted
            if _data(record).get("state") == "accepted"
            and _data(record).get("call_id") in run_call_ids
        )

    @property
    def primary_delegate_id(self) -> str | None:
        if not self.accepted_runs:
            return None
        value = _data(self.accepted_runs[0][1]).get("delegate_id")
        return value if isinstance(value, str) else None

    @property
    def primary_handoffs(self) -> tuple[tuple[int, Mapping[str, Any]], ...]:
        delegate_id = self.primary_delegate_id
        return tuple(
            (index, record)
            for index, record in self.handoffs
            if _data(record).get("delegate_id") == delegate_id
        )

    @property
    def handoff_index(self) -> int:
        return self.primary_handoffs[0][0] if self.primary_handoffs else self.end

    @property
    def final_fact_index(self) -> int | None:
        return self.final_facts[0][0] if self.final_facts else None

    @property
    def status_transcript(self) -> tuple[int, Mapping[str, Any]] | None:
        """The first transcript after the status question — the status answer itself."""
        question_index = self.question_index
        if question_index is None:
            return None
        for index, record in self.transcripts:
            if index > question_index:
                return index, record
        return None

    def ack_transcripts(self) -> tuple[tuple[int, Mapping[str, Any]], ...]:
        """Transcripts spoken between acceptance and the first progress announcement."""
        start = self.accepted_runs[0][0] if self.accepted_runs else -1
        if self.progress_facts:
            end = self.progress_facts[0][0]
        elif self.question_index is not None:
            end = self.question_index
        else:
            end = self.handoff_index
        return tuple((index, record) for index, record in self.transcripts if start < index < end)

    def latest_summary_before(self, index: int) -> str | None:
        """The newest structurally valid progress summary stored before ``index``."""
        latest: str | None = None
        for progress_index, record in self.progress:
            if progress_index >= index:
                break
            data = _data(record)
            summary = data.get("summary")
            if isinstance(summary, str) and valid_progress_summary(
                summary, phase=str(data.get("phase"))
            ):
                latest = summary
        return latest


def _timeline(items: Sequence[Mapping[str, Any]]) -> _Timeline:
    return _Timeline(
        items=tuple(items),
        accepted=tuple(_events(items, "tool.accepted")),
        calls=tuple(_events(items, "tool.call")),
        running=tuple(_events(items, "delegate.running")),
        progress=tuple(_events(items, "codex.progress")),
        memory_progress=tuple(_events(items, "memory.progress")),
        progress_facts=tuple(_events(items, "progress.fact")),
        progress_terminals=tuple(_events(items, "progress.response.terminal")),
        questions=tuple(_events(items, "status.question")),
        transcripts=tuple(_events(items, "status.transcript")),
        handoffs=tuple(_events(items, "codex.handoff")),
        final_facts=tuple(_events(items, "final.fact")),
        final_terminals=tuple(_events(items, "final.response.terminal")),
        audio=tuple(_events(items, "audio.delta")),
        fixture_gates=tuple(_events(items, "fixture.gate")),
    )


def _structural_findings(items: Sequence[Mapping[str, Any]]) -> list[Finding]:
    findings: list[Finding] = []
    refs: set[str] = set()
    previous = -1.0
    for record in items:
        event_ref = record.get("event_ref")
        if not isinstance(event_ref, str) or not event_ref:
            findings.append(_finding("invalid_event_ref", record, "event_ref must be non-empty"))
        elif event_ref in refs:
            findings.append(_finding("duplicate_event_ref", record, f"duplicate {event_ref}"))
        else:
            refs.add(event_ref)

        t_ms = record.get("t_ms")
        if isinstance(t_ms, bool) or not isinstance(t_ms, (int, float)) or t_ms < previous:
            findings.append(
                _finding("invalid_event_time", record, "t_ms must be numeric and monotonic")
            )
        else:
            previous = float(t_ms)

        kind = record.get("kind")
        if not isinstance(kind, str) or kind not in _RECORD_FIELDS:
            findings.append(_finding("invalid_event_kind", record, "kind must be allowlisted"))
        if not isinstance(record.get("data"), Mapping):
            findings.append(_finding("invalid_event_shape", record, "data must be a mapping"))
        if kind == "status.transcript":
            text = _text(_data(record).get("text"))
            markers = [marker for marker in _SPOKEN_PROTOCOL_MARKERS if marker in text]
            if markers:
                findings.append(
                    _finding(
                        "spoken_transcript_recites_protocol",
                        record,
                        f"spoken transcript exposed host protocol markers: {markers}",
                    )
                )
    return findings


def _gate_dispatch(timeline: _Timeline) -> GateResult:
    findings: list[Finding] = []
    accepted = list(timeline.accepted_runs)
    if not accepted:
        findings.append(
            _finding("dispatch_missing", None, "the scenario needs one accepted codex__run")
        )
        return _gate(GATE_DISPATCH, findings)
    if len(accepted) != 1:
        findings.append(
            _finding(
                "unexpected_accepted_run_count",
                accepted[1][1],
                f"expected exactly one accepted call, saw {len(accepted)}",
            )
        )

    accepted_index, accepted_record = accepted[0]
    call_id = _data(accepted_record).get("call_id")
    matching = [
        record for _index, record in timeline.calls if _data(record).get("call_id") == call_id
    ]
    if not matching or any(_data(record).get("name") != CODEX_RUN_TOOL_NAME for record in matching):
        findings.append(
            _finding(
                "dispatch_tool_mismatch",
                accepted_record,
                f"the accepted call must be {CODEX_RUN_TOOL_NAME}",
            )
        )

    delegates = {
        _data(record).get("delegate_id")
        for _index, record in accepted
        if isinstance(_data(record).get("delegate_id"), str)
    }
    if len(delegates) != 1:
        findings.append(
            _finding(
                "unexpected_delegate_count",
                accepted_record,
                f"expected exactly one delegate, saw {len(delegates)}",
            )
        )

    for _index, record in timeline.ack_transcripts():
        text = _text(_data(record).get("text"))
        claimed = [claim for claim in _ACK_COMPLETION_CLAIMS if claim in text.lower()]
        if _STANDALONE_ACK_COMPLETION.search(text):
            claimed.append("完成")
        if claimed:
            findings.append(
                _finding(
                    "ack_claims_completion",
                    record,
                    f"the acknowledgement must not claim completion: {claimed}",
                )
            )

    delegate_id = next(iter(delegates), None)
    running = [
        (index, record)
        for index, record in timeline.running
        if _data(record).get("delegate_id") == delegate_id
    ]
    if not running:
        findings.append(
            _finding("delegate_not_running", accepted_record, "the delegate never reached running")
        )
    else:
        question_index = timeline.question_index
        first_running = running[0][0]
        if first_running <= accepted_index:
            findings.append(
                _finding("delegate_running_before_dispatch", running[0][1], "running precedes ack")
            )
        if question_index is not None and first_running >= question_index:
            findings.append(
                _finding(
                    "delegate_running_after_status_question",
                    running[0][1],
                    "the delegate must already be running when the question is asked",
                )
            )
    return _gate(GATE_DISPATCH, findings)


def _gate_projection(timeline: _Timeline) -> GateResult:
    findings: list[Finding] = []
    handoff_index = timeline.handoff_index
    before_handoff = [
        (index, record) for index, record in timeline.progress if index < handoff_index
    ]
    if not before_handoff:
        findings.append(
            _finding(
                "progress_missing_before_handoff",
                None,
                "at least one completed item must project progress before Handoff",
            )
        )

    for _index, record in timeline.progress:
        data = _data(record)
        if not valid_progress_summary(data.get("summary"), phase=str(data.get("phase"))):
            findings.append(
                _finding(
                    "progress_summary_invalid",
                    record,
                    "summary must be absent, or 1..400 printable chars on a working event",
                )
            )

    summaries = [
        _text(_data(record).get("summary"))
        for _index, record in before_handoff
        if isinstance(_data(record).get("summary"), str)
        and valid_progress_summary(
            _data(record).get("summary"), phase=str(_data(record).get("phase"))
        )
    ]
    informative = [summary for summary in summaries if is_informative(summary)]
    spoken_informative = tuple(
        prepared
        for summary in informative
        if (prepared := prepare_for_speech(summary, limit=SPEECH_FINAL_LIMIT)[0])
    )
    if not informative:
        code = "progress_summary_not_informative" if summaries else "progress_summary_missing"
        detail = (
            "every pre-Handoff summary was counts-only"
            if summaries
            else "no structurally valid summary preceded Handoff"
        )
        findings.append(_finding(code, None, detail))

    stored = {
        _text(_data(record).get("summary"))
        for _index, record in timeline.memory_progress
        if isinstance(_data(record).get("summary"), str)
    }
    if informative and not any(summary in stored for summary in informative):
        findings.append(
            _finding(
                "progress_summary_absent_from_memory",
                None,
                "the informative summary never reached Runtime Memory",
            )
        )

    selected_facts: list[tuple[Mapping[str, Any], str]] = []
    for _index, record in timeline.progress_facts:
        data = _data(record)
        event_id = _text(data.get("event_id"))
        content = _text(data.get("content"))
        if event_id.startswith("suggestion:"):
            selected_facts.append((record, content))
        elif (
            event_id.startswith("progress:")
            and ":started:" in event_id
            and content == "Codex 已开始处理这个任务。"
        ):
            # Thread readiness is a host lifecycle fact, not worker-authored
            # progress. It may be spoken directly; only working milestones must
            # pass through Surrogate selection.
            continue
        else:
            findings.append(
                _finding(
                    "progress_fact_not_surrogate_selected",
                    record,
                    "Codex working progress must arrive through a selected suggestion",
                )
            )
    if informative and not selected_facts:
        findings.append(
            _finding(
                "selected_progress_missing",
                None,
                "no Surrogate-selected progress fact carried the informative milestone",
            )
        )
    elif selected_facts and not any(is_informative(content) for _record, content in selected_facts):
        findings.append(
            _finding(
                "selected_progress_not_informative",
                selected_facts[0][0],
                "the selected progress fact carried no informative milestone",
            )
        )
    elif (
        selected_facts
        and spoken_informative
        and not any(
            summary in content
            for _record, content in selected_facts
            for summary in spoken_informative
        )
    ):
        findings.append(
            _finding(
                "selected_progress_not_grounded",
                selected_facts[0][0],
                "the selected progress fact did not contain a projected informative summary",
            )
        )

    # Both summary-bearing and fallback speech are user-facing. Neither may expose the
    # internal protocol field names that the speech-preparation path is meant to hide.
    spoken_sources = (
        *((record, _text(_data(record).get("summary"))) for _index, record in timeline.progress),
        *(
            (record, _text(_data(record).get("summary")))
            for _index, record in timeline.memory_progress
        ),
        *(
            (record, _text(_data(record).get("content")))
            for _index, record in timeline.progress_facts
        ),
    )
    for record, text in spoken_sources:
        hits = _forbidden_hits(text, _FORBIDDEN_PROGRESS_SUBSTRINGS)
        if hits:
            findings.append(
                _finding(
                    "progress_summary_leaked_forbidden_content",
                    record,
                    f"forbidden content in a stored or spoken progress form: {list(hits)}",
                )
            )

    seen_contents: set[str] = set()
    seen_event_ids: set[str] = set()
    for _index, record in timeline.progress_facts:
        data = _data(record)
        content = _text(data.get("content"))
        event_id = _text(data.get("event_id"))
        if content and content in seen_contents:
            findings.append(
                _finding(
                    "duplicate_progress_fact",
                    record,
                    "an identical summary must not be spoken twice",
                )
            )
        elif event_id and event_id in seen_event_ids:
            findings.append(
                _finding("duplicate_progress_fact", record, f"duplicate event id {event_id}")
            )
        seen_contents.add(content)
        seen_event_ids.add(event_id)
    return _gate(GATE_PROJECTION, findings)


def _gate_status_timing(timeline: _Timeline) -> GateResult:
    findings: list[Finding] = []
    if not timeline.questions:
        findings.append(
            _finding("status_question_missing", None, "the scenario needs one status question")
        )
        return _gate(GATE_STATUS_TIMING, findings)
    if len(timeline.questions) != 1:
        findings.append(
            _finding(
                "unexpected_status_question_count",
                timeline.questions[1][1],
                f"expected one status question, saw {len(timeline.questions)}",
            )
        )

    question_index, question = timeline.questions[0]
    earlier_facts = [index for index, _record in timeline.progress_facts if index < question_index]
    if not earlier_facts:
        findings.append(
            _finding(
                "status_question_before_progress_fact",
                question,
                "the question must follow a confirmed-injected progress host fact",
            )
        )
    else:
        released = [
            index
            for index, _record in timeline.progress_terminals
            if earlier_facts[0] < index < question_index
        ]
        if not released:
            findings.append(
                _finding(
                    "status_question_before_progress_response_terminal",
                    question,
                    "the progress response must be terminal before the question is sent",
                )
            )

    if timeline.handoff_index <= question_index:
        findings.append(
            _finding(
                "handoff_before_status_question",
                question,
                "no terminal Handoff may be visible when the question is accepted",
            )
        )

    status_transcript = timeline.status_transcript
    if status_transcript is not None:
        status_response = _text(_data(status_transcript[1]).get("response_id"))
        prior = {
            _text(_data(record).get("response_id"))
            for index, record in timeline.transcripts
            if index < question_index
        }
        prior |= {
            _text(_data(record).get("response_id"))
            for _index, record in timeline.progress_terminals
        }
        later = {
            _text(_data(record).get("response_id")) for _index, record in timeline.final_terminals
        }
        final_fact_index = timeline.final_fact_index
        if final_fact_index is not None:
            later |= {
                _text(_data(record).get("response_id"))
                for index, record in timeline.transcripts
                if index > final_fact_index
            }
        if status_response and status_response in (prior | later):
            findings.append(
                _finding(
                    "status_response_id_reused",
                    status_transcript[1],
                    "the status response must be distinct from the ack and final responses",
                )
            )
    return _gate(GATE_STATUS_TIMING, findings)


def _gate_status_answer(timeline: _Timeline) -> GateResult:
    findings: list[Finding] = []
    status_transcript = timeline.status_transcript
    if status_transcript is None:
        findings.append(
            _finding("status_transcript_missing", None, "the status question was never answered")
        )
        return _gate(GATE_STATUS_ANSWER, findings)

    _index, record = status_transcript
    text = _text(_data(record).get("text")).strip()
    if not text:
        findings.append(_finding("status_transcript_empty", record, "the status answer was empty"))
        return _gate(GATE_STATUS_ANSWER, findings)

    question_index = timeline.question_index
    summary = timeline.latest_summary_before(
        question_index if question_index is not None else timeline.end
    )
    summary_text = summary or ""

    if _is_generic_only(text):
        findings.append(
            _finding(
                "status_answer_generic_only",
                record,
                "the answer carried nothing beyond generic running-state filler",
            )
        )
    elif not ((concepts_in(text) & concepts_in(summary_text)) - WEAK_CONCEPTS):
        findings.append(
            _finding(
                "status_answer_not_grounded",
                record,
                "the answer shares no fixture concept with the latest stored summary",
            )
        )

    claimed = [claim for claim in _COMPLETION_CLAIMS if claim in text and claim not in summary_text]
    if claimed:
        findings.append(
            _finding(
                "status_answer_claims_completion",
                record,
                f"the answer claims completion the summary does not support: {claimed}",
            )
        )

    hits = _forbidden_hits(text, _FORBIDDEN_STATUS_SUBSTRINGS)
    if _SHELL_PROMPT_PATTERN.search(text):
        hits = (*hits, "raw_command")
    if hits:
        findings.append(
            _finding(
                "status_answer_recites_protocol",
                record,
                f"the answer recited protocol or machine detail: {list(hits)}",
            )
        )

    if "空格" in text:
        findings.append(
            _finding(
                "status_answer_contains_spoken_space",
                record,
                "the answer contained the standalone spoken token 空格",
            )
        )
    return _gate(GATE_STATUS_ANSWER, findings)


def _gate_final_delivery(timeline: _Timeline, *, live: bool) -> GateResult:
    findings: list[Finding] = []
    handoffs = timeline.primary_handoffs
    if not handoffs:
        findings.append(_finding("handoff_missing", None, "the delegate never produced a Handoff"))
        return _gate(GATE_FINAL_DELIVERY, findings)
    if len(handoffs) != 1:
        findings.append(
            _finding(
                "unexpected_handoff_count",
                handoffs[1][1],
                f"expected exactly one run Handoff, saw {len(handoffs)}",
            )
        )

    if not timeline.final_facts:
        findings.append(
            _finding("final_fact_missing", None, "the prepared final view was never delivered")
        )
        return _gate(GATE_FINAL_DELIVERY, findings)
    if len(timeline.final_facts) != 1:
        findings.append(
            _finding(
                "duplicate_final_fact",
                timeline.final_facts[1][1],
                f"expected exactly one final fact, saw {len(timeline.final_facts)}",
            )
        )

    final_index, final_record = timeline.final_facts[0]
    status_transcript = timeline.status_transcript
    if status_transcript is not None and final_index <= status_transcript[0]:
        findings.append(
            _finding(
                "final_fact_entered_active_status_response",
                final_record,
                "the final host fact must wait for the status response to release the floor",
            )
        )

    if len(timeline.final_terminals) != 1:
        findings.append(
            _finding(
                "unexpected_final_response_count",
                timeline.final_terminals[1][1] if len(timeline.final_terminals) > 1 else None,
                f"expected one terminal final response, saw {len(timeline.final_terminals)}",
            )
        )

    content = _text(_data(final_record).get("content")).strip()
    envelope = [needle for needle in ('"outcome"', "sha256", "exit_code") if needle in content]
    if not content or content.startswith("{") or envelope:
        findings.append(
            _finding(
                "final_fact_not_speech_view",
                final_record,
                f"the final fact must be a prepared speech view, not an envelope: {envelope}",
            )
        )

    if live and timeline.final_terminals:
        final_responses = {
            _text(_data(record).get("response_id")) for _index, record in timeline.final_terminals
        }
        audible = [
            record
            for _index, record in timeline.audio
            if _text(_data(record).get("response_id")) in final_responses
        ]
        if not audible:
            findings.append(
                _finding(
                    "final_response_audio_missing",
                    final_record,
                    "a live final response must produce at least one audio delta",
                )
            )
    return _gate(GATE_FINAL_DELIVERY, findings)


def _gate_fixture_verification(
    timeline: _Timeline,
    *,
    required_fixture_gates: Collection[str],
) -> GateResult:
    findings: list[Finding] = []
    required = frozenset(required_fixture_gates)
    seen: dict[str, list[Mapping[str, Any]]] = {}
    for _index, record in timeline.fixture_gates:
        seen.setdefault(_text(_data(record).get("name")), []).append(record)

    missing = sorted(required - seen.keys())
    if missing:
        findings.append(
            _finding("fixture_gate_missing", None, f"missing independent checks: {missing}")
        )
    for name in sorted(required & seen.keys()):
        entries = seen[name]
        if len(entries) != 1:
            findings.append(
                _finding(
                    "fixture_gate_count",
                    entries[1] if len(entries) > 1 else None,
                    f"fixture gate {name} must appear exactly once",
                )
            )
        for entry in entries:
            if _data(entry).get("passed") is not True:
                findings.append(
                    _finding("fixture_gate_failed", entry, f"fixture gate {name} did not pass")
                )
    return _gate(GATE_FIXTURE_VERIFICATION, findings)


def _metrics(timeline: _Timeline, *, live: bool) -> dict[str, Any]:
    def at(index: int | None) -> float | None:
        if index is None or not (0 <= index < timeline.end):
            return None
        value = timeline.items[index].get("t_ms")
        return (
            float(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else None
        )

    def gap(start: int | None, end: int | None) -> float | None:
        first, second = at(start), at(end)
        return None if first is None or second is None else max(0.0, second - first)

    summaries = [
        _text(_data(record).get("summary"))
        for _index, record in timeline.progress
        if isinstance(_data(record).get("summary"), str)
    ]
    informative_index: int | None = None
    for index, record in timeline.progress:
        summary = _data(record).get("summary")
        if isinstance(summary, str) and is_informative(summary):
            informative_index = index
            break

    accepted_index = timeline.accepted_runs[0][0] if timeline.accepted_runs else None
    first_fact = timeline.progress_facts[0][0] if timeline.progress_facts else None
    question_index = timeline.question_index
    status_transcript = timeline.status_transcript
    audio_bytes: dict[str, int] = {}
    for _index, record in timeline.audio:
        data = _data(record)
        count = data.get("bytes")
        if isinstance(count, int) and not isinstance(count, bool):
            audio_bytes[_text(data.get("response_id"))] = (
                audio_bytes.get(_text(data.get("response_id")), 0) + count
            )
    return {
        "live": live,
        "progress_event_count": len(timeline.progress),
        "distinct_summary_count": len(set(summaries)),
        "informative_summary_count": sum(1 for summary in summaries if is_informative(summary)),
        "progress_fact_count": len(timeline.progress_facts),
        "dispatch_to_first_informative_summary_ms": gap(accepted_index, informative_index),
        "progress_fact_to_status_question_ms": gap(first_fact, question_index),
        "status_question_to_status_transcript_ms": gap(
            question_index, status_transcript[0] if status_transcript else None
        ),
        "status_transcript_to_final_fact_ms": gap(
            status_transcript[0] if status_transcript else None, timeline.final_fact_index
        ),
        "dispatch_to_handoff_ms": gap(
            accepted_index, timeline.handoff_index if timeline.primary_handoffs else None
        ),
        "audio_bytes_by_response": dict(sorted(audio_bytes.items())),
    }


def evaluate_codex_progress_status(
    records: Sequence[Mapping[str, Any]],
    *,
    live: bool,
    required_fixture_gates: Collection[str] | None = None,
) -> ScenarioReport:
    """Judge one recorded attempt against Gates 1-6. Gate 6 is live-only."""
    items = list(records)
    timeline = _timeline(items)
    gates = [
        _gate_dispatch(timeline),
        _gate_projection(timeline),
        _gate_status_timing(timeline),
        _gate_status_answer(timeline),
        _gate_final_delivery(timeline, live=live),
    ]
    if live:
        gates.append(
            _gate_fixture_verification(
                timeline,
                required_fixture_gates=(
                    REQUIRED_FIXTURE_GATES
                    if required_fixture_gates is None
                    else required_fixture_gates
                ),
            )
        )

    findings = tuple(
        [*_structural_findings(items), *(finding for gate in gates for finding in gate.findings)]
    )
    return ScenarioReport(
        findings=findings,
        gates=tuple(gates),
        metrics=_metrics(timeline, live=live),
    )


def failure_reason(report: ScenarioReport) -> str | None:
    """Attribute a red result, so a live failure is diagnosable without re-reading events.

    ``no_worker_narration`` is still a red result — the product promise is an informative
    answer — but it says the worker never emitted prose, rather than blaming the
    projection/sanitizer/session pipeline.
    """
    if report.passed:
        return None
    codes = {finding.code for finding in report.findings}
    if codes <= _NARRATION_CASCADE and "progress_summary_not_informative" in codes:
        return "no_worker_narration"
    return "gate_violation"


def build_report_mapping(
    report: ScenarioReport,
    *,
    records: Sequence[Mapping[str, Any]],
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    """Return the JSON-serializable gate report written next to the event stream."""
    return {
        "scenario_id": SCENARIO_ID,
        "manifest": dict(manifest),
        "passed": report.passed,
        "failure_reason": failure_reason(report),
        "first_failed_gate": report.first_failed_gate,
        "gates": [
            {
                "name": gate.name,
                "passed": gate.passed,
                "findings": [asdict(finding) for finding in gate.findings],
            }
            for gate in report.gates
        ],
        "findings": [asdict(finding) for finding in report.findings],
        "metrics": dict(report.metrics),
        "event_count": len(records),
        "event_refs": [record.get("event_ref") for record in records],
    }
