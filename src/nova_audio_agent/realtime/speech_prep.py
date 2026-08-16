"""R104: deterministic speech preparation for realtime-injected facts.

Markdown/JSON/identifier *structure* stripping is host-side (this module);
digit/unit *verbalization* stays with the provider's own TTS normalization.
Pure string transforms — no I/O, no clock, no dependencies.
"""

from __future__ import annotations

import re

SPEECH_FINAL_LIMIT = 600

_FENCE = re.compile(r"```.*?```", re.DOTALL)
# P2: an unclosed fence has no reliable end boundary (English finals are common),
# so only the marker and its language word are removed; the text stays.
_UNCLOSED_FENCE = re.compile(r"```[a-zA-Z0-9_+#-]*\s*")
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
# CP2: \S+ would swallow CJK punctuation and the no-space prose after a URL.
_BARE_URL = re.compile(r"https?://[^\s，。、；：！？（）【】「」]+")
_HEX_RUN = re.compile(r"\b[0-9a-fA-F]{32,}\b")
# CP2: upstream flattens newlines to spaces, so headings arrive mid-line.
_HEADING = re.compile(r"(?:^|(?<=\s))#{1,6}\s+")
_EMPHASIS = re.compile(r"\*{1,3}|_{2,}")
_LIST_MARKER = re.compile(r"(?:^|(?<=\s))[-*]\s+")
_RULE_RUN = re.compile(r"-{3,}")
_ARROW = re.compile(r"[←→↑↓⇐⇒]|->|=>")
_WHITESPACE = re.compile(r"\s+")

_CODE_PLACEHOLDER = "（代码示例略）"
_LINK_PLACEHOLDER = "（链接略）"


def prepare_for_speech(text: str, *, limit: int) -> tuple[str, bool]:
    """Reduce markdown/protocol structure to speakable prose; report clipping."""
    prepped = _FENCE.sub(_CODE_PLACEHOLDER, text)
    prepped = _UNCLOSED_FENCE.sub(" ", prepped)
    prepped = _INLINE_CODE.sub(r"\1", prepped)
    prepped = _IMAGE.sub(r"\1", prepped)
    prepped = _LINK.sub(r"\1", prepped)
    prepped = _BARE_URL.sub(_LINK_PLACEHOLDER, prepped)
    prepped = _HEX_RUN.sub("", prepped)
    prepped = _HEADING.sub("", prepped)
    prepped = _EMPHASIS.sub("", prepped)
    prepped = prepped.replace("|", " ")
    prepped = _RULE_RUN.sub(" ", prepped)
    prepped = _LIST_MARKER.sub("", prepped)
    prepped = _ARROW.sub(" ", prepped)
    prepped = _WHITESPACE.sub(" ", prepped).strip()
    if len(prepped) <= limit:
        return prepped, False
    return prepped[:limit], True
