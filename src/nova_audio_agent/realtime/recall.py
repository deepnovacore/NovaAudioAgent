"""Pure, bounded recall projection over the current conversation Memory."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Literal

from nova_audio_agent.memory import (
    CONVERSATION_CHANNEL,
    Memory,
    MemoryItem,
    MemoryRef,
    Outcome,
    Trust,
    parse_ref,
)
from nova_audio_agent.realtime.evidence import safe_memory_evidence

RecallScope = Literal["recent", "any"]
RecallMatch = Literal["lexical", "recency_fallback"]
RecallState = Literal["ok", "empty", "error"]

_RECENT_PER_CHANNEL = 5
_ANY_SCAN_LIMIT = 500
_HIT_LIMIT = 5
_ASCII_TOKEN = re.compile(r"[a-z0-9]+")
_CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")


class RecallOriginError(ValueError):
    """The recall cutoff is not an accepted trusted-user conversation item."""


@dataclass(frozen=True, slots=True)
class RecallHit:
    ref: MemoryRef
    channel: str
    ts: float
    trust: Trust
    outcome: Outcome | None
    match: RecallMatch
    evidence: str


@dataclass(frozen=True, slots=True)
class RecallView:
    state: RecallState
    scope: RecallScope
    raw_scanned: int
    searched_count: int
    scan_truncated: bool
    hits: tuple[RecallHit, ...]
    omitted: int


@dataclass(frozen=True, slots=True)
class _Candidate:
    item: MemoryItem
    evidence: str
    score: int


def compile_memory_recall(
    memory: Memory,
    *,
    query: str,
    scope: RecallScope,
    before_ref: MemoryRef,
) -> RecallView:
    """Compile a deterministic recall view without mutating Memory."""
    normalized_query = query.strip()
    if not normalized_query or len(normalized_query) > 512:
        raise ValueError("query must contain 1 to 512 characters")
    if scope not in {"recent", "any"}:
        raise ValueError("scope must be 'recent' or 'any'")
    cutoff_seq = _conversation_cutoff(memory, before_ref)
    raw_items, scan_truncated = _raw_candidates(memory, scope, cutoff_seq)
    query_tokens = _lexical_tokens(normalized_query)
    candidates: list[_Candidate] = []
    for item in raw_items:
        evidence = safe_memory_evidence(item)
        if not evidence:
            continue
        score = len(query_tokens & _lexical_tokens(evidence))
        candidates.append(_Candidate(item=item, evidence=evidence, score=score))

    if not candidates:
        return RecallView(
            state="empty",
            scope=scope,
            raw_scanned=len(raw_items),
            searched_count=0,
            scan_truncated=scan_truncated,
            hits=(),
            omitted=0,
        )

    lexical = [candidate for candidate in candidates if candidate.score > 0]
    if lexical:
        ranked = sorted(lexical, key=_lexical_rank_key)
        match: RecallMatch = "lexical"
    else:
        ranked = sorted(candidates, key=_recency_rank_key)
        match = "recency_fallback"

    selected = ranked[:_HIT_LIMIT]
    hits = tuple(
        RecallHit(
            ref=candidate.item.ref,
            channel=candidate.item.channel,
            ts=candidate.item.ts,
            trust=candidate.item.trust,
            outcome=candidate.item.outcome,
            match=match,
            evidence=candidate.evidence,
        )
        for candidate in selected
    )
    return RecallView(
        state="ok",
        scope=scope,
        raw_scanned=len(raw_items),
        searched_count=len(candidates),
        scan_truncated=scan_truncated,
        hits=hits,
        omitted=len(ranked) - len(selected),
    )


def encode_memory_recall(view: RecallView, *, max_chars: int = 3000) -> str:
    """Encode a recall view, dropping only whole trailing hits to fit the budget."""
    if max_chars <= 0:
        raise ValueError("max_chars must be positive")
    hits = [asdict(hit) for hit in view.hits]
    removed = 0
    while True:
        payload = {
            "state": view.state,
            "scope": view.scope,
            "raw_scanned": view.raw_scanned,
            "searched_count": view.searched_count,
            "scan_truncated": view.scan_truncated,
            "hits": hits,
            "omitted": view.omitted + removed,
        }
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        if len(encoded) <= max_chars:
            return encoded
        if not hits:
            raise ValueError("max_chars is too small for the recall envelope")
        hits.pop()
        removed += 1


def _conversation_cutoff(memory: Memory, before_ref: MemoryRef) -> int:
    try:
        channel, seq = parse_ref(before_ref)
    except ValueError as exc:
        raise RecallOriginError(
            "before_ref must name an existing trusted user conversation item"
        ) from exc
    conversation = memory.channels[CONVERSATION_CHANNEL]
    if channel != CONVERSATION_CHANNEL or not 1 <= seq <= len(conversation.items):
        raise RecallOriginError("before_ref must name an existing trusted user conversation item")
    origin = conversation.items[seq - 1]
    if origin.ref != before_ref or origin.trust != "trusted_user":
        raise RecallOriginError("before_ref must name an existing trusted user conversation item")
    return seq


def _raw_candidates(
    memory: Memory,
    scope: RecallScope,
    cutoff_seq: int,
) -> tuple[list[MemoryItem], bool]:
    if scope == "recent":
        items: list[MemoryItem] = []
        for channel in memory.channels.values():
            eligible = (
                channel.items[: cutoff_seq - 1]
                if channel.name == CONVERSATION_CHANNEL
                else channel.items
            )
            items.extend(eligible[-_RECENT_PER_CHANNEL:])
        return items, False

    items = [
        item
        for channel in memory.channels.values()
        for item in channel.items
        if item.channel != CONVERSATION_CHANNEL or item.seq < cutoff_seq
    ]
    items.sort(key=_newest_raw_key)
    return items[:_ANY_SCAN_LIMIT], len(items) > _ANY_SCAN_LIMIT


def _lexical_tokens(text: str) -> frozenset[str]:
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens = {token for token in _ASCII_TOKEN.findall(normalized) if len(token) >= 2}
    for match in _CJK_RUN.finditer(normalized):
        run = match.group()
        tokens.update(run[index : index + 2] for index in range(len(run) - 1))
    return frozenset(tokens)


def _newest_raw_key(item: MemoryItem) -> tuple[float, int, str, int]:
    return (-item.ts, -item.priority, item.channel, -item.seq)


def _lexical_rank_key(candidate: _Candidate) -> tuple[int, float, int, str, int]:
    item = candidate.item
    return (-candidate.score, -item.ts, -item.priority, item.channel, item.seq)


def _recency_rank_key(candidate: _Candidate) -> tuple[float, int, str, int]:
    item = candidate.item
    return (-item.ts, -item.priority, item.channel, item.seq)
