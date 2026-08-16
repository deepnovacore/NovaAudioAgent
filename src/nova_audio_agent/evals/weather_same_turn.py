"""Scenario definition, recorder, and evaluator for ``qwen-weather-same-turn.v1``.

Authority: ``docs/superpowers/specs/2026-08-06-realtime-weather-live-e2e-design.md``.

One scenario drives two backends through the same normalized records and the same
gates: the deterministic CI test (``tests/test_e2e_weather_same_turn.py``) and the
explicitly-invoked live command (``scripts/eval_weather_same_turn.py``). Only Gate 6
is backend-specific; ``live=False`` skips it.

The evaluator judges text and protocol behavior. It never asserts a particular
temperature or condition, because a live run's facts change with the weather — it
asserts that the spoken answer overlaps the evidence that run actually retrieved.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from nova_audio_agent.clock import Clock, RealClock

SCENARIO_ID = "qwen-weather-same-turn.v1"
USER_TURN = "北京现在天气怎么样？请告诉我气温和天气状况。"

#: Mirror of ``realtime.service.MAX_HOST_FACT_CHARS``. Duplicated deliberately: the
#: evaluator is an independent check on the serialization boundary, not a caller of it.
MAX_TOOL_OUTPUT_CHARS = 3000
MAX_RESULT_TITLE_CHARS = 120
MAX_RESULT_SNIPPET_CHARS = 400

_RECORD_FIELDS: dict[str, frozenset[str]] = {
    "user.turn": frozenset({"text"}),
    "tool.call": frozenset({"call_id", "name", "query", "k"}),
    "tool.accepted": frozenset({"call_id", "delegate_id", "sync_result", "state", "code"}),
    "origin.terminal": frozenset({"response_id", "status"}),
    "search.handoff": frozenset({"delegate_id", "outcome", "result_count"}),
    # ``content`` is the confirmed function_call_output JSON string.
    "tool.output": frozenset({"call_id", "content"}),
    "continuation.created": frozenset({"response_id"}),
    "continuation.terminal": frozenset({"response_id", "status"}),
    "answer.transcript": frozenset({"text"}),
    "audio.delta": frozenset({"response_id", "bytes"}),
}

SEARCH_TOOL_NAME = "search__search"
_CODEX_TOOL_PREFIX = "codex__"

_LOCATION_TOKENS = ("北京", "beijing")
_WEATHER_INTENT_TOKENS = ("天气", "气温", "weather", "temperature")

#: Closed weather vocabulary used for evidence overlap. Deliberately small: the gate
#: proves grounding, not paraphrase quality.
_CONDITION_TOKENS = ("晴", "多云", "阴", "雨", "雪", "雾", "霾", "风", "雷")
_TEMPERATURE_TOKENS = ("度", "摄氏", "℃")
_NUMBER_PATTERN = re.compile(r"\d{1,3}")

_REALTIME_DENIALS = ("无法获取", "不能获取", "没有实时", "无法提供实时")
_PROTOCOL_RECITATIONS = (
    "query_ref",
    "evidence_ref",
    "call_id",
    "delegate_id",
    "function_call_output",
    "state=",
    '"results"',
    "http://",
    "https://",
)
_FORBIDDEN_OUTPUT_SUBSTRINGS = (
    "query_ref",
    "evidence_ref",
    "provider_request_id",
    "content_digest",
    "fetched_at",
    "http://",
    "https://",
)
_ATTRIBUTION_PHRASES = ("搜索结果", "搜索显示", "根据搜索", "查到", "查询结果", "来源")
#: The fixed user turn names Beijing, so the design doc lets the answer either name it
#: or leave it "unambiguously resolved from the question". Requiring the literal token
#: would fail a natural "现在是晴天，二十五度" on a healthy pipeline, and semantic
#: failures are never retried away — so only a *conflicting* city is a defect.
_CONFLICTING_CITY_TOKENS = (
    "上海",
    "广州",
    "深圳",
    "杭州",
    "成都",
    "天津",
    "重庆",
    "南京",
    "武汉",
    "西安",
)

GATE_TOOL_ROUTING = "gate1_tool_routing"
GATE_SYNCHRONOUS_HOLD = "gate2_synchronous_hold"
GATE_TOOL_RESULT_INTEGRITY = "gate3_tool_result_integrity"
GATE_CONTINUATION_LIFECYCLE = "gate4_continuation_lifecycle"
GATE_GROUNDED_ANSWER = "gate5_grounded_answer"
GATE_LIVE_OUTPUT_HEALTH = "gate6_live_output_health"


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

    Same posture as ``evals.live_tetris.EvaluationRecorder``: the recorder is the
    redaction boundary, so an artifact can never carry a field the evaluator does
    not read.
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
            raise ScenarioTimeout(f"weather_same_turn_timeout:{kind}") from None


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


def _contains_any(text: str, tokens: Sequence[str]) -> bool:
    lowered = text.lower()
    return any(token.lower() in lowered for token in tokens)


@dataclass(frozen=True, slots=True)
class _Evidence:
    """Normalized weather concepts extracted from the confirmed tool output."""

    concepts: frozenset[str]
    numbers: frozenset[str]
    titles: tuple[str, ...]
    sources: tuple[str, ...]
    result_count: int


_EMPTY_EVIDENCE = _Evidence(
    concepts=frozenset(),
    numbers=frozenset(),
    titles=(),
    sources=(),
    result_count=0,
)


def _extract_evidence(payload: object) -> _Evidence:
    if not isinstance(payload, Mapping):
        return _EMPTY_EVIDENCE
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        return _EMPTY_EVIDENCE
    concepts: set[str] = set()
    numbers: set[str] = set()
    titles: list[str] = []
    sources: list[str] = []
    count = 0
    for raw in raw_results:
        if not isinstance(raw, Mapping):
            continue
        count += 1
        title = raw.get("title")
        snippet = raw.get("snippet")
        source = raw.get("source")
        if isinstance(title, str) and title:
            titles.append(title)
        if isinstance(source, str) and source:
            sources.append(source)
        blob = " ".join(value for value in (title, snippet) if isinstance(value, str) and value)
        for token in (*_CONDITION_TOKENS, *_TEMPERATURE_TOKENS):
            if token in blob:
                concepts.add(token)
        numbers.update(_NUMBER_PATTERN.findall(blob))
    concepts.update(numbers)
    return _Evidence(
        concepts=frozenset(concepts),
        numbers=frozenset(numbers),
        titles=tuple(titles),
        sources=tuple(sources),
        result_count=count,
    )


def _gate_tool_routing(
    items: Sequence[Mapping[str, Any]],
) -> tuple[GateResult, Mapping[str, Any] | None]:
    """Gate 1: exactly one accepted ``search__search`` call, no codex tool, sane params."""
    findings: list[Finding] = []
    calls = _events(items, "tool.call")
    searches = [entry for entry in calls if _data(entry[1]).get("name") == SEARCH_TOOL_NAME]
    codex_calls = [
        entry
        for entry in calls
        if str(_data(entry[1]).get("name") or "").startswith(_CODEX_TOOL_PREFIX)
    ]
    for _index, record in codex_calls:
        findings.append(
            _finding("codex_tool_called", record, "this scenario must never call a codex tool")
        )
    if not searches:
        findings.append(
            _finding(
                "search_call_missing",
                None,
                "the provider must answer the weather question with one search__search call",
            )
        )
        return _gate(GATE_TOOL_ROUTING, findings), None
    if len(searches) > 1:
        findings.append(
            _finding(
                "search_call_not_unique",
                searches[1][1],
                f"expected exactly one search__search call, saw {len(searches)}",
            )
        )
    call = searches[0][1]
    data = _data(call)
    query = data.get("query")
    if not isinstance(query, str) or not query.strip():
        findings.append(_finding("search_query_empty", call, "the search query must be non-empty"))
    else:
        if not _contains_any(query, _LOCATION_TOKENS):
            findings.append(
                _finding(
                    "search_query_missing_location",
                    call,
                    "the query must carry the Beijing concept from the user turn",
                )
            )
        if not _contains_any(query, _WEATHER_INTENT_TOKENS):
            findings.append(
                _finding(
                    "search_query_missing_weather_intent",
                    call,
                    "the query must carry the weather concept from the user turn",
                )
            )
    k = data.get("k")
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= 5:
        findings.append(_finding("search_k_out_of_range", call, "k must be an integer from 1 to 5"))
    return _gate(GATE_TOOL_ROUTING, findings), call


def _gate_synchronous_hold(
    items: Sequence[Mapping[str, Any]],
    call: Mapping[str, Any] | None,
) -> tuple[GateResult, str | None]:
    """Gate 2: one correlated delegate, and no continuation before the hold releases.

    The hold releases only once **both** the origin terminal and the confirmed tool
    output exist, in either order (design doc, Gate 2). A missing prerequisite makes
    the boundary unreachable, so every continuation is premature.
    """
    findings: list[Finding] = []
    call_id = _data(call).get("call_id") if call is not None else None
    acceptances = [
        entry
        for entry in _events(items, "tool.accepted")
        if call_id is not None and _data(entry[1]).get("call_id") == call_id
    ]
    delegate_id: str | None = None
    if not acceptances:
        findings.append(
            _finding("tool_acceptance_missing", call, "the search call was never accepted")
        )
    else:
        acceptance = acceptances[0][1]
        accepted = _data(acceptance)
        raw_delegate = accepted.get("delegate_id")
        if isinstance(raw_delegate, str) and raw_delegate:
            delegate_id = raw_delegate
        else:
            findings.append(
                _finding(
                    "sync_delegate_missing",
                    acceptance,
                    "an accepted search call must carry a non-empty delegate id",
                )
            )
        if accepted.get("sync_result") is not True:
            findings.append(
                _finding(
                    "sync_result_not_declared",
                    acceptance,
                    "search.SEARCH declares sync_result; the acceptance must report it",
                )
            )
        if accepted.get("code") != "accepted":
            findings.append(
                _finding(
                    "tool_call_not_accepted",
                    acceptance,
                    "the deciding path requires an accepted tool call",
                )
            )

    handoffs = _events(items, "search.handoff")
    if not handoffs:
        findings.append(
            _finding("search_handoff_missing", None, "the search delegate produced no handoff")
        )
    else:
        handoff = handoffs[0][1]
        if delegate_id is None or _data(handoff).get("delegate_id") != delegate_id:
            findings.append(
                _finding(
                    "handoff_delegate_mismatch",
                    handoff,
                    "the handoff must correlate to the accepted search delegate",
                )
            )

    origin_terminals = _events(items, "origin.terminal")
    outputs = [
        entry
        for entry in _events(items, "tool.output")
        if call_id is not None and _data(entry[1]).get("call_id") == call_id
    ]
    origin_index: float = origin_terminals[0][0] if origin_terminals else math.inf
    output_index: float = outputs[0][0] if outputs else math.inf
    boundary = max(origin_index, output_index)
    for index, record in _events(items, "continuation.created"):
        if index < boundary:
            findings.append(
                _finding(
                    "premature_continuation",
                    record,
                    "a continuation was created before the origin terminal and the tool output",
                )
            )
    return _gate(GATE_SYNCHRONOUS_HOLD, findings), delegate_id


def _gate_tool_result_integrity(
    items: Sequence[Mapping[str, Any]],
    call: Mapping[str, Any] | None,
) -> tuple[GateResult, _Evidence]:
    """Gate 3: one parseable, bounded, leak-free ``function_call_output``."""
    findings: list[Finding] = []
    call_id = _data(call).get("call_id") if call is not None else None
    outputs = [
        entry
        for entry in _events(items, "tool.output")
        if call_id is not None and _data(entry[1]).get("call_id") == call_id
    ]
    if not outputs:
        findings.append(
            _finding("tool_output_missing", call, "the search call confirmed no tool output")
        )
        return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _EMPTY_EVIDENCE

    record = outputs[0][1]
    content = _data(record).get("content")
    if not isinstance(content, str) or not content:
        findings.append(
            _finding("tool_output_missing", record, "the tool output carried no content")
        )
        return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _EMPTY_EVIDENCE

    if len(content) > MAX_TOOL_OUTPUT_CHARS:
        findings.append(
            _finding(
                "tool_output_too_long",
                record,
                f"tool output is {len(content)} chars, over {MAX_TOOL_OUTPUT_CHARS}",
            )
        )
    for forbidden in _FORBIDDEN_OUTPUT_SUBSTRINGS:
        if forbidden in content:
            findings.append(
                _finding(
                    "tool_output_internal_ref_leak",
                    record,
                    f"tool output leaked {forbidden!r} to the provider",
                )
            )
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, UnicodeDecodeError):
        findings.append(
            _finding("tool_output_not_json", record, "the tool output must parse as JSON")
        )
        return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _EMPTY_EVIDENCE

    if not isinstance(payload, Mapping):
        findings.append(
            _finding("tool_output_not_json", record, "the tool output must be a JSON object")
        )
        return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _EMPTY_EVIDENCE

    state = payload.get("state")
    if state != "ok":
        findings.append(
            _finding(
                "tool_output_not_ok",
                record,
                f"the deciding path needs a successful result, saw state={state!r}",
            )
        )
        return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _EMPTY_EVIDENCE

    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        findings.append(
            _finding(
                "tool_output_missing_query",
                record,
                "a successful output must echo the query it grounded on",
            )
        )
    raw_results = payload.get("results")
    results = raw_results if isinstance(raw_results, list) else []
    if not results:
        findings.append(
            _finding(
                "tool_output_no_results",
                record,
                "a successful output must carry at least one result",
            )
        )
    for entry in results:
        if not isinstance(entry, Mapping) or any(
            not isinstance(entry.get(field), str) for field in ("title", "snippet", "source")
        ):
            findings.append(
                _finding(
                    "tool_output_result_field_missing",
                    record,
                    "each result needs title, snippet, and host-side source",
                )
            )
            continue
        title = str(entry["title"])
        snippet = str(entry["snippet"])
        if len(title) > MAX_RESULT_TITLE_CHARS or len(snippet) > MAX_RESULT_SNIPPET_CHARS:
            findings.append(
                _finding(
                    "tool_output_result_unbounded",
                    record,
                    "result titles and snippets must stay within their host-side bounds",
                )
            )
    return _gate(GATE_TOOL_RESULT_INTEGRITY, findings), _extract_evidence(payload)


def _gate_continuation_lifecycle(
    items: Sequence[Mapping[str, Any]],
    call: Mapping[str, Any] | None,
) -> GateResult:
    """Gate 4: exactly one continuation, after the output, with one terminal state."""
    findings: list[Finding] = []
    call_id = _data(call).get("call_id") if call is not None else None
    outputs = [
        entry
        for entry in _events(items, "tool.output")
        if call_id is not None and _data(entry[1]).get("call_id") == call_id
    ]
    if len(outputs) > 1:
        findings.append(
            _finding(
                "duplicate_tool_output",
                outputs[1][1],
                "a duplicate handoff observation must not produce a second tool output",
            )
        )
    creations = _events(items, "continuation.created")
    if not creations:
        findings.append(
            _finding(
                "continuation_missing",
                None,
                "a confirmed tool result must create exactly one continuation",
            )
        )
        return _gate(GATE_CONTINUATION_LIFECYCLE, findings)
    if len(creations) > 1:
        findings.append(
            _finding(
                "duplicate_continuation",
                creations[1][1],
                f"expected exactly one continuation, saw {len(creations)}",
            )
        )
    creation_index, creation = creations[0]
    if not outputs or creation_index < outputs[0][0]:
        findings.append(
            _finding(
                "continuation_before_tool_output",
                creation,
                "the continuation must start after the tool output is injected",
            )
        )
    response_id = _data(creation).get("response_id")
    terminals = [
        entry
        for entry in _events(items, "continuation.terminal")
        if _data(entry[1]).get("response_id") == response_id
    ]
    if not terminals:
        findings.append(
            _finding(
                "continuation_terminal_missing",
                creation,
                "the continuation must reach one terminal disposition",
            )
        )
    elif len(terminals) > 1:
        findings.append(
            _finding(
                "duplicate_continuation_terminal",
                terminals[1][1],
                "the continuation must reach exactly one terminal disposition",
            )
        )
    return _gate(GATE_CONTINUATION_LIFECYCLE, findings)


def _gate_grounded_answer(
    items: Sequence[Mapping[str, Any]],
    evidence: _Evidence,
) -> tuple[GateResult, bool]:
    """Gate 5: the spoken answer is grounded in this run's evidence.

    Source attribution is computed but never gates (design doc): it is prompted
    behavior with too much phrasing freedom to be a reliable live red.
    """
    findings: list[Finding] = []
    transcripts = _events(items, "answer.transcript")
    texts = [
        str(_data(record).get("text") or "")
        for _index, record in transcripts
        if isinstance(_data(record).get("text"), str)
    ]
    text = next((value for value in texts if value.strip()), "")
    if not text:
        findings.append(
            _finding(
                "answer_transcript_missing",
                transcripts[0][1] if transcripts else None,
                "the continuation must produce a non-empty answer transcript",
            )
        )
        return _gate(GATE_GROUNDED_ANSWER, findings), False

    record = next(
        (entry[1] for entry in transcripts if _data(entry[1]).get("text") == text),
        None,
    )
    answer_concepts = {token for token in _CONDITION_TOKENS if token in text}
    answer_concepts.update(token for token in _TEMPERATURE_TOKENS if token in text)
    answer_numbers = set(_NUMBER_PATTERN.findall(text))
    grounded = bool(answer_concepts & evidence.concepts) or bool(answer_numbers & evidence.numbers)
    if not grounded:
        findings.append(
            _finding(
                "answer_not_grounded_in_evidence",
                record,
                "the answer shares no weather concept or temperature with the returned evidence",
            )
        )
    if not _contains_any(text, _LOCATION_TOKENS) and _contains_any(text, _CONFLICTING_CITY_TOKENS):
        findings.append(
            _finding(
                "answer_location_mismatch",
                record,
                "the answer named a different city while never naming Beijing",
            )
        )
    for denial in _REALTIME_DENIALS:
        if denial in text:
            findings.append(
                _finding(
                    "answer_claims_realtime_unavailable",
                    record,
                    f"the answer claimed {denial!r} after a successful search result",
                )
            )
    for recitation in _PROTOCOL_RECITATIONS:
        if recitation.lower() in text.lower():
            findings.append(
                _finding(
                    "answer_recites_protocol",
                    record,
                    f"the answer recited protocol structure {recitation!r}",
                )
            )
    attributed = _contains_any(text, _ATTRIBUTION_PHRASES) or any(
        token and token in text for token in (*evidence.titles, *evidence.sources)
    )
    return _gate(GATE_GROUNDED_ANSWER, findings), attributed


def _gate_live_output_health(items: Sequence[Mapping[str, Any]]) -> GateResult:
    """Gate 6: the live continuation produced audible bytes and a final transcript."""
    findings: list[Finding] = []
    audible = [
        entry
        for entry in _events(items, "audio.delta")
        if isinstance(_data(entry[1]).get("bytes"), int)
        and not isinstance(_data(entry[1]).get("bytes"), bool)
        and int(_data(entry[1])["bytes"]) > 0
    ]
    if not audible:
        findings.append(
            _finding("live_audio_missing", None, "the live continuation produced no audio bytes")
        )
    if not any(
        str(_data(record).get("text") or "").strip()
        for _index, record in _events(items, "answer.transcript")
    ):
        findings.append(
            _finding(
                "live_transcript_missing",
                None,
                "the live continuation produced no non-empty transcript",
            )
        )
    return _gate(GATE_LIVE_OUTPUT_HEALTH, findings)


def evaluate_weather_same_turn(
    records: Sequence[Mapping[str, Any]],
    *,
    live: bool,
) -> ScenarioReport:
    """Apply Gates 1-6 to one normalized scenario record stream."""
    items = list(records)
    gate1, call = _gate_tool_routing(items)
    gate2, delegate_id = _gate_synchronous_hold(items, call)
    gate3, evidence = _gate_tool_result_integrity(items, call)
    gate4 = _gate_continuation_lifecycle(items, call)
    gate5, attributed = _gate_grounded_answer(items, evidence)
    gates = [gate1, gate2, gate3, gate4, gate5]
    if live:
        gates.append(_gate_live_output_health(items))

    audio_bytes = sum(
        int(_data(record)["bytes"])
        for _index, record in _events(items, "audio.delta")
        if isinstance(_data(record).get("bytes"), int)
        and not isinstance(_data(record).get("bytes"), bool)
    )
    transcripts = _events(items, "answer.transcript")
    transcript_chars = max(
        (len(str(_data(record).get("text") or "")) for _index, record in transcripts),
        default=0,
    )
    metrics: dict[str, Any] = {
        # Diagnostic, never a gate (design doc, Gate 5).
        "source_attribution": attributed,
        # Also diagnostic: the fixed turn names Beijing, so an answer that omits it is
        # still unambiguous. Only a *conflicting* city fails Gate 5.
        "answer_names_location": any(
            token in str(_data(record).get("text") or "").lower()
            for _index, record in transcripts
            for token in _LOCATION_TOKENS
        ),
        "evidence_result_count": evidence.result_count,
        "evidence_concepts": sorted(evidence.concepts),
        "search_delegate_correlated": delegate_id is not None,
        "audio_bytes": audio_bytes,
        "transcript_chars": transcript_chars,
        "event_count": len(items),
    }
    findings = tuple(finding for gate in gates for finding in gate.findings)
    return ScenarioReport(findings=findings, gates=tuple(gates), metrics=metrics)


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
