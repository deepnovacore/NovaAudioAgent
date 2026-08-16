"""Bounded Tavily Search adapter for Stage D0.

Search is the always-on readonly executor. The transport owns one bounded HTTP
request; the adapter owns the existing ExecutorAdapter contract and evidence
normalization. Neither layer writes Memory or speaks to the user.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import unicodedata
from typing import Any, Mapping, Protocol
from urllib.parse import urlsplit

import httpx

from nova_audio_agent.memory import HandoffPolicy
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

_PROVIDER = "tavily"
_ENDPOINT = "https://api.tavily.com/search"
_HTTP_TIMEOUT = 8.0
_MAX_RESPONSE_BYTES = 256 * 1024
_MAX_QUERY_CHARS = 512
_MAX_RESULTS = 5
_MAX_TITLE_CHARS = 300
_MAX_SNIPPET_CHARS = 2_000
_MAX_URL_CHARS = 2_048

SEARCH = OpSpec(
    name="search",
    description="搜索公开网页，返回带来源的标题、摘要和证据引用",
    params={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "minLength": 1,
                "maxLength": _MAX_QUERY_CHARS,
                "description": "要搜索的简短查询",
            },
            "k": {
                "type": "integer",
                "minimum": 1,
                "maximum": _MAX_RESULTS,
                "description": "返回结果数量，1 到 5",
            },
        },
        "required": ["query", "k"],
        "additionalProperties": False,
    },
    readonly=True,
    deadline_budget=10.0,
    verifies=("search",),
    sync_result=True,
)

SEARCH_POLICY = HandoffPolicy(
    channel="search",
    priority=40,
    wake="surrogate",
    typical_latency=3.0,
    compress_watermark=20,
)

SEARCH_MANIFEST = ExecutorManifest(
    name="search",
    ops=(SEARCH,),
    policy=SEARCH_POLICY,
)


class TavilyTransportFailure(RuntimeError):
    """A credential-free transport observation normalized by SearchAdapter."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class SearchTransport(Protocol):
    async def search(self, query: str, *, max_results: int) -> dict[str, Any]: ...


class TavilyTransport:
    """One direct, bounded Tavily `/search` request with no retries."""

    def __init__(self, api_key: str | None, *, client: httpx.AsyncClient | None = None) -> None:
        self._api_key = api_key or ""
        self._client = client

    async def search(self, query: str, *, max_results: int) -> dict[str, Any]:
        if not self._api_key:
            raise TavilyTransportFailure("authentication")
        if self._client is not None:
            return await self._search_with(self._client, query=query, max_results=max_results)
        async with httpx.AsyncClient(http2=True) as client:
            return await self._search_with(client, query=query, max_results=max_results)

    async def _search_with(
        self,
        client: httpx.AsyncClient,
        *,
        query: str,
        max_results: int,
    ) -> dict[str, Any]:
        payload = {
            "query": query,
            "search_depth": "basic",
            "max_results": max_results,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
        }
        try:
            async with asyncio.timeout(_HTTP_TIMEOUT):
                async with client.stream(
                    "POST",
                    _ENDPOINT,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    follow_redirects=False,
                    timeout=_HTTP_TIMEOUT,
                ) as response:
                    self._check_status(response.status_code)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(body) + len(chunk) > _MAX_RESPONSE_BYTES:
                            raise TavilyTransportFailure("response_too_large")
                        body.extend(chunk)
        except TavilyTransportFailure:
            raise
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise TavilyTransportFailure("timeout") from exc
        except httpx.TransportError as exc:
            raise TavilyTransportFailure("transport") from exc

        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TavilyTransportFailure("malformed_response") from exc
        if not isinstance(value, dict):
            raise TavilyTransportFailure("malformed_response")
        return value

    @staticmethod
    def _check_status(status: int) -> None:
        if 300 <= status < 400:
            raise TavilyTransportFailure("redirect")
        if status in {401, 403}:
            raise TavilyTransportFailure("authentication")
        if status == 429:
            raise TavilyTransportFailure("rate_limited")
        if status >= 500:
            raise TavilyTransportFailure("upstream")
        if status >= 400:
            raise TavilyTransportFailure("provider_rejected")


class SearchAdapter:
    manifest = SEARCH_MANIFEST

    def __init__(self, transport: SearchTransport) -> None:
        self._transport = transport

    async def dispatch(
        self,
        op: str,
        request: dict[str, Any],
        ctx: DispatchContext,
    ) -> Handoff:
        if op != "search":
            return self._failure("failed", "unknown_op")

        normalized = _normalize_request(request)
        if normalized is None:
            return self._failure("failed", "invalid_params")
        query, max_results = normalized

        query_ref = _ref(
            "query",
            {
                "provider": _PROVIDER,
                "query": query,
                "delegate_id": ctx.delegate.delegate_id,
            },
        )
        try:
            response = await self._transport.search(query, max_results=max_results)
        except TavilyTransportFailure as exc:
            outcome = "failed" if exc.code in {"authentication", "provider_rejected"} else "unknown"
            return self._failure(
                outcome,
                exc.code,
                query=query,
                query_ref=query_ref,
                fetched_at=ctx.clock.now(),
            )
        except Exception:
            return self._failure(
                "unknown",
                "adapter_exception",
                query=query,
                query_ref=query_ref,
                fetched_at=ctx.clock.now(),
            )

        fetched_at = ctx.clock.now()
        results = _normalize_results(
            response.get("results"),
            query_ref=query_ref,
            fetched_at=fetched_at,
            max_results=max_results,
        )
        if not results:
            return self._failure(
                "unknown",
                "empty_evidence",
                query=query,
                query_ref=query_ref,
                fetched_at=fetched_at,
            )

        provider_request_id = response.get("request_id")
        content = {
            "provider": _PROVIDER,
            "query": query,
            "query_ref": query_ref,
            "fetched_at": fetched_at,
            "provider_request_id": (
                provider_request_id if isinstance(provider_request_id, str) else None
            ),
            "results": results,
        }
        refs = (query_ref, *(result["evidence_ref"] for result in results))
        return Handoff(
            outcome="ok",
            trust="untrusted_external",
            content=content,
            refs=refs,
        )

    @staticmethod
    def _failure(
        outcome: str,
        code: str,
        *,
        query: str | None = None,
        query_ref: str | None = None,
        fetched_at: float | None = None,
    ) -> Handoff:
        content: dict[str, Any] = {"error": code, "provider": _PROVIDER}
        if query is not None:
            content["query"] = query
        if query_ref is not None:
            content["query_ref"] = query_ref
        if fetched_at is not None:
            content["fetched_at"] = fetched_at
        return Handoff(
            outcome=outcome,  # type: ignore[arg-type]
            trust="untrusted_external",
            content=content,
            refs=(query_ref,) if query_ref is not None else (),
        )


def _normalize_request(request: Mapping[str, Any]) -> tuple[str, int] | None:
    if set(request) != {"query", "k"}:
        return None
    query = request.get("query")
    max_results = request.get("k")
    if not isinstance(query, str):
        return None
    query = query.strip()
    if not query or len(query) > _MAX_QUERY_CHARS:
        return None
    if (
        not isinstance(max_results, int)
        or isinstance(max_results, bool)
        or not 1 <= max_results <= _MAX_RESULTS
    ):
        return None
    return query, max_results


def _normalize_results(
    value: Any,
    *,
    query_ref: str,
    fetched_at: float,
    max_results: int,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    results: list[dict[str, Any]] = []
    # Preserve provider positions; skipped malformed entries intentionally leave rank gaps.
    for rank, raw in enumerate(value, start=1):
        if len(results) >= max_results:
            break
        if not isinstance(raw, Mapping):
            continue
        title = _text(raw.get("title"), _MAX_TITLE_CHARS)
        snippet = _text(raw.get("content"), _MAX_SNIPPET_CHARS)
        canonical_url = _canonical_url(raw.get("url"))
        if not title or not snippet or not canonical_url:
            continue
        content_digest = _digest(
            {
                "title": title,
                "snippet": snippet,
                "canonical_url": canonical_url,
            }
        )
        evidence_ref = _ref(
            "evidence",
            {
                "provider": _PROVIDER,
                "query_ref": query_ref,
                "rank": rank,
                "fetched_at": fetched_at,
                "canonical_url": canonical_url,
                "content_digest": content_digest,
            },
        )
        results.append(
            {
                "rank": rank,
                "title": title,
                "source_label": _source_label(canonical_url),
                "snippet": snippet,
                "canonical_url": canonical_url,
                "content_digest": content_digest,
                "evidence_ref": evidence_ref,
            }
        )
    return results


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _canonical_url(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > _MAX_URL_CHARS:
        return ""
    if any(
        character.isspace() or unicodedata.category(character) in {"Cc", "Cf"}
        for character in value
    ):
        return ""
    try:
        parsed = urlsplit(value)
        _ = parsed.port
        normalized = httpx.URL(value)
    except ValueError:
        return ""
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or normalized.scheme not in {"http", "https"}
        or not normalized.host
        or normalized.userinfo
        or "\\" in value
        or "<" in value
        or ">" in value
    ):
        return ""
    canonical = str(normalized.copy_with(fragment=None))
    return canonical if len(canonical) <= _MAX_URL_CHARS else ""


def _source_label(url: str) -> str:
    hostname = urlsplit(url).hostname or ""
    return hostname[4:] if hostname.startswith("www.") else hostname


def _digest(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _ref(kind: str, value: Mapping[str, Any]) -> str:
    return f"web.search://{kind}/{_digest(value)}"
