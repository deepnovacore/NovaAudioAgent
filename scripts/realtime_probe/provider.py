from __future__ import annotations

import re
from typing import Protocol


class ProviderError(RuntimeError):
    """A sanitized provider or transport failure safe to persist in probe artifacts."""

    def __init__(self, message: str, *, reason_code: str = "ProviderError") -> None:
        super().__init__(message)
        self.reason_code = (
            reason_code if re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", reason_code) else "ProviderError"
        )


class RealtimeProvider(Protocol):
    async def connect(self) -> dict[str, object]: ...

    async def send(self, event: dict[str, object]) -> None: ...

    async def receive(self) -> dict[str, object]: ...

    async def close(self) -> None: ...
