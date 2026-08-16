from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from nova_audio_agent.ports import Handoff

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke_search.py"
_SPEC = importlib.util.spec_from_file_location("smoke_search", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
validate_handoff = _MODULE.validate_handoff
run = _MODULE.run


def test_live_smoke_validator_accepts_bounded_traceable_evidence() -> None:
    handoff = Handoff(
        outcome="ok",
        trust="untrusted_external",
        content={
            "provider": "tavily",
            "query_ref": "web.search://query/q",
            "results": [
                {
                    "title": "Nova Audio Agent",
                    "source_label": "example.com",
                    "snippet": "bounded",
                    "canonical_url": "https://example.com/nova",
                    "content_digest": "a" * 64,
                    "evidence_ref": "web.search://evidence/e",
                }
            ],
        },
        refs=("web.search://query/q", "web.search://evidence/e"),
    )

    assert validate_handoff(handoff) == {
        "result_count": 1,
        "source_labels": ["example.com"],
        "refs_valid": True,
    }


@pytest.mark.parametrize(
    "handoff",
    [
        Handoff(
            outcome="unknown",
            trust="untrusted_external",
            content={"error": "timeout"},
        ),
        Handoff(
            outcome="ok",
            trust="untrusted_external",
            content={
                "provider": "tavily",
                "query_ref": "web.search://query/q",
                "results": [
                    {
                        "title": "Nova Audio Agent",
                        "source_label": "example.com",
                        "snippet": "x" * 2_001,
                        "canonical_url": "https://example.com",
                        "content_digest": "a" * 64,
                        "evidence_ref": "web.search://evidence/missing",
                        "raw_content": "must not exist",
                    }
                ],
            },
            refs=("web.search://query/q",),
        ),
    ],
)
def test_live_smoke_validator_rejects_failed_or_unbounded_observations(
    handoff: Handoff,
) -> None:
    with pytest.raises(ValueError):
        validate_handoff(handoff)


async def test_live_smoke_reuses_one_http2_client_across_the_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client_options: dict[str, Any] = {}
    transport_clients: list[object] = []

    class _Settings:
        @staticmethod
        def require_tavily_api_key() -> str:
            return "secret"

    class _Client:
        def __init__(self, **options: Any) -> None:
            client_options.update(options)

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

    class _Transport:
        def __init__(self, _api_key: str, *, client: object) -> None:
            transport_clients.append(client)

        async def search(self, _query: str, *, max_results: int) -> dict[str, Any]:
            assert max_results == 3
            return {
                "request_id": "fixture",
                "results": [
                    {
                        "title": "Nova Audio Agent",
                        "url": "https://example.com/nova",
                        "content": "bounded evidence",
                    }
                ],
            }

    monkeypatch.setattr(_MODULE, "Settings", _Settings)
    monkeypatch.setattr(_MODULE, "TavilyTransport", _Transport)
    monkeypatch.setattr(
        _MODULE,
        "httpx",
        SimpleNamespace(AsyncClient=_Client),
        raising=False,
    )

    summaries = await run("Nova Audio Agent", runs=2)

    assert client_options == {"http2": True}
    assert len(transport_clients) == 1
    assert summaries == [
        {
            "run": 1,
            "result_count": 1,
            "source_labels": ["example.com"],
            "refs_valid": True,
        },
        {
            "run": 2,
            "result_count": 1,
            "source_labels": ["example.com"],
            "refs_valid": True,
        },
    ]
