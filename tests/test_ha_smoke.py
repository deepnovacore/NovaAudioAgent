from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.executors.home_assistant import (
    HomeAssistantAdapter,
    HomeAssistantTransportFailure,
)

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "smoke_ha.py"
_SPEC = importlib.util.spec_from_file_location("smoke_ha", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
run_smoke = _MODULE.run_smoke


class _StatefulTransport:
    def __init__(
        self,
        *,
        state: str = "on",
        brightness_pct: int = 80,
        color_temp_kelvin: int = 3000,
        reported_color_temp_offset: int = 0,
        fail_service_call: int | None = None,
        cancel_get_state_call: int | None = None,
    ) -> None:
        self.state = state
        self.brightness_pct = brightness_pct
        self.color_temp_kelvin = color_temp_kelvin
        self.reported_color_temp_offset = reported_color_temp_offset
        self.fail_service_call = fail_service_call
        self.cancel_get_state_call = cancel_get_state_call
        self.calls: list[tuple[str, Any]] = []
        self._service_calls = 0
        self._get_state_calls = 0

    async def get_state(self, entity_id: str) -> dict[str, Any]:
        self._get_state_calls += 1
        self.calls.append(("get_state", entity_id))
        if self.cancel_get_state_call == self._get_state_calls:
            raise asyncio.CancelledError
        return {
            "entity_id": entity_id,
            "state": self.state,
            "attributes": {
                "brightness": round(self.brightness_pct * 255 / 100),
                "color_temp_kelvin": (self.color_temp_kelvin + self.reported_color_temp_offset),
                "min_color_temp_kelvin": 1700,
                "max_color_temp_kelvin": 6500,
                "supported_color_modes": ["color_temp"],
            },
            "last_changed": "2026-07-30T09:00:00+00:00",
            "last_updated": "2026-07-30T09:00:01+00:00",
        }

    async def call_service(
        self,
        service: str,
        service_data: dict[str, Any],
    ) -> list[dict[str, Any]]:
        self._service_calls += 1
        self.calls.append((service, dict(service_data)))
        if self.fail_service_call == self._service_calls:
            raise HomeAssistantTransportFailure("transport")
        if service == "turn_off":
            self.state = "off"
        else:
            self.state = "on"
            if "brightness_pct" in service_data:
                self.brightness_pct = service_data["brightness_pct"]
            if "color_temp_kelvin" in service_data:
                self.color_temp_kelvin = service_data["color_temp_kelvin"]
        return []


def _adapter(transport: _StatefulTransport) -> HomeAssistantAdapter:
    return HomeAssistantAdapter(transport, entity_id="light.bedside_lamp")


async def test_smoke_is_readonly_unless_an_apply_request_is_supplied() -> None:
    transport = _StatefulTransport()

    summary = await run_smoke(_adapter(transport), VirtualClock())

    assert summary["mode"] == "read_only"
    assert summary["state"]["state"] == "on"
    assert transport.calls == [("get_state", "light.bedside_lamp")]


async def test_apply_smoke_refuses_to_write_when_the_original_state_is_on() -> None:
    transport = _StatefulTransport(state="on")

    with pytest.raises(RuntimeError, match="original state is on"):
        await run_smoke(
            _adapter(transport),
            VirtualClock(),
            apply_request={"brightness_pct": 35},
        )

    assert [call[0] for call in transport.calls] == ["get_state"]


async def test_apply_smoke_off_cycle_accepts_kelvin_tolerance_and_restores_off() -> None:
    transport = _StatefulTransport(state="off", reported_color_temp_offset=25)

    summary = await run_smoke(
        _adapter(transport),
        VirtualClock(),
        apply_request={"brightness_pct": 35, "color_temp_kelvin": 2700},
    )

    assert summary["mode"] == "apply"
    assert summary["verified"]["brightness_pct"] == 35
    assert summary["verified"]["color_temp_kelvin"] == 2725
    assert summary["restored"]["state"] == "off"
    assert [call[0] for call in transport.calls] == [
        "get_state",
        "turn_on",
        "get_state",
        "turn_off",
        "get_state",
    ]


async def test_apply_smoke_restores_off_before_reraising_cancellation() -> None:
    transport = _StatefulTransport(state="off", cancel_get_state_call=2)

    with pytest.raises(asyncio.CancelledError):
        await run_smoke(
            _adapter(transport),
            VirtualClock(),
            apply_request={"brightness_pct": 35},
        )

    assert [call[0] for call in transport.calls] == [
        "get_state",
        "turn_on",
        "get_state",
        "turn_off",
        "get_state",
    ]
    assert transport.state == "off"


async def test_apply_smoke_rejects_kelvin_tolerance_above_50_and_restores_off() -> None:
    transport = _StatefulTransport(state="off", reported_color_temp_offset=51)

    with pytest.raises(RuntimeError, match="color temperature mismatch"):
        await run_smoke(
            _adapter(transport),
            VirtualClock(),
            apply_request={"color_temp_kelvin": 2700},
        )

    assert [call[0] for call in transport.calls] == [
        "get_state",
        "turn_on",
        "get_state",
        "turn_off",
        "get_state",
    ]


async def test_apply_smoke_refuses_to_write_when_the_original_state_is_unavailable() -> None:
    transport = _StatefulTransport(state="unavailable")

    with pytest.raises(RuntimeError, match="original state"):
        await run_smoke(
            _adapter(transport),
            VirtualClock(),
            apply_request={"power": "on"},
        )

    assert [call[0] for call in transport.calls] == ["get_state"]


async def test_apply_smoke_surfaces_a_restore_failure() -> None:
    transport = _StatefulTransport(state="off", fail_service_call=2)

    with pytest.raises(RuntimeError, match="restore"):
        await run_smoke(
            _adapter(transport),
            VirtualClock(),
            apply_request={"brightness_pct": 35},
        )

    assert transport._service_calls == 2
