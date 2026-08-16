#!/usr/bin/env python3
"""Run explicit, credential-safe Stage D0 Tavily smoke checks."""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

import httpx

from nova_audio_agent.clock import RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.search import SEARCH, SearchAdapter, TavilyTransport
from nova_audio_agent.ports import DelegateRequest, DispatchContext, Handoff, bind_delegate

_FORBIDDEN_RESULT_FIELDS = frozenset({"raw_content", "body", "html"})


def validate_handoff(handoff: Handoff) -> dict[str, Any]:
    """Return a printable summary or reject an unbounded/untraceable live result."""
    if handoff.outcome != "ok" or handoff.trust != "untrusted_external":
        raise ValueError(
            "search smoke did not return evidence: "
            f"outcome={handoff.outcome} error={handoff.content.get('error', 'none')}"
        )
    if handoff.content.get("provider") != "tavily":
        raise ValueError("search smoke returned the wrong provider")
    query_ref = handoff.content.get("query_ref")
    results = handoff.content.get("results")
    if not isinstance(query_ref, str) or query_ref not in handoff.refs:
        raise ValueError("search smoke query ref is missing")
    if not isinstance(results, list) or not results:
        raise ValueError("search smoke returned no evidence")

    labels: list[str] = []
    for result in results:
        if not isinstance(result, dict):
            raise ValueError("search smoke result is malformed")
        if _FORBIDDEN_RESULT_FIELDS & set(result):
            raise ValueError("search smoke exposed page content")
        snippet = result.get("snippet")
        url = result.get("canonical_url")
        digest = result.get("content_digest")
        evidence_ref = result.get("evidence_ref")
        label = result.get("source_label")
        if not isinstance(snippet, str) or len(snippet) > 2_000:
            raise ValueError("search smoke snippet exceeded its bound")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise ValueError("search smoke URL is not canonical HTTP(S)")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError("search smoke digest is malformed")
        if not isinstance(evidence_ref, str) or evidence_ref not in handoff.refs:
            raise ValueError("search smoke evidence ref is missing")
        if not isinstance(label, str) or not label:
            raise ValueError("search smoke source label is missing")
        labels.append(label)

    return {
        "result_count": len(results),
        "source_labels": labels,
        "refs_valid": True,
    }


async def run(query: str, *, runs: int) -> list[dict[str, Any]]:
    settings = Settings()
    clock = RealClock()
    summaries: list[dict[str, Any]] = []
    async with httpx.AsyncClient(http2=True) as client:
        adapter = SearchAdapter(TavilyTransport(settings.require_tavily_api_key(), client=client))
        for index in range(1, runs + 1):
            request = {"query": query, "k": 3}
            delegate = bind_delegate(
                DelegateRequest(
                    executor="search",
                    op="search",
                    request=request,
                    origin_ref="conversation:1",
                ),
                wake_reason=WakeReason(
                    kind="user_input",
                    priority=100,
                    routing_class="user_awaited",
                ),
                op=SEARCH,
                now=clock.now(),
                delegate_id=f"d-live-{index}",
            )
            handoff = await adapter.dispatch(
                "search",
                request,
                DispatchContext(clock=clock, delegate=delegate),
            )
            summaries.append({"run": index, **validate_handoff(handoff)})
    return summaries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--query",
        default="Nova Audio Agent continuous agent architecture",
        help="Short public query sent to Tavily",
    )
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    summaries = asyncio.run(run(args.query, runs=args.runs))
    print(json.dumps(summaries, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
