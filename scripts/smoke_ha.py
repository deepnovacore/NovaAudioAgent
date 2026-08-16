#!/usr/bin/env python3
"""Run an explicit Home Assistant light smoke check."""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

import httpx

from nova_audio_agent.clock import Clock, RealClock
from nova_audio_agent.config import Settings
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.home_assistant import (
    HOME_ASSISTANT_MANIFEST,
    HomeAssistantAdapter,
    HomeAssistantTransport,
)
from nova_audio_agent.ports import DelegateRequest, DispatchContext, Handoff, bind_delegate

_USER_WAKE = WakeReason(
    kind="user_input",
    priority=100,
    routing_class="user_awaited",
)


async def run_smoke(
    adapter: HomeAssistantAdapter,
    clock: Clock,
    *,
    apply_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    before = _require_ok(
        await _dispatch(adapter, clock, "get_state", {}, sequence=1),
        phase="read original state",
    )
    if apply_request is None:
        return {"mode": "read_only", "state": before}

    restore_request = _restore_request(before)
    primary_error: BaseException | None = None
    verified: dict[str, Any] | None = None
    try:
        _require_ok(
            await _dispatch(
                adapter,
                clock,
                "set_light",
                apply_request,
                sequence=2,
            ),
            phase="apply requested state",
        )
        verified = _require_ok(
            await _dispatch(adapter, clock, "get_state", {}, sequence=3),
            phase="verify requested state",
        )
        _verify_state(verified, apply_request, phase="requested state")
    except BaseException as exc:
        primary_error = exc

    try:
        _require_ok(
            await _dispatch(
                adapter,
                clock,
                "set_light",
                restore_request,
                sequence=4,
            ),
            phase="restore original state",
        )
        restored = _require_ok(
            await _dispatch(adapter, clock, "get_state", {}, sequence=5),
            phase="verify restored state",
        )
        _verify_state(restored, restore_request, phase="restored state")
    except Exception as exc:
        raise RuntimeError(f"restore failed: {exc}") from exc

    if primary_error is not None:
        raise primary_error
    assert verified is not None
    return {
        "mode": "apply",
        "before": before,
        "verified": verified,
        "restored": restored,
    }


async def _dispatch(
    adapter: HomeAssistantAdapter,
    clock: Clock,
    op_name: str,
    request: dict[str, Any],
    *,
    sequence: int,
) -> Handoff:
    op = HOME_ASSISTANT_MANIFEST.op(op_name)
    assert op is not None
    delegate = bind_delegate(
        DelegateRequest(
            executor="ha",
            op=op_name,
            request=request,
            origin_ref="conversation:1",
        ),
        wake_reason=_USER_WAKE,
        op=op,
        now=clock.now(),
        delegate_id=f"d-ha-smoke-{sequence}",
    )
    return await adapter.dispatch(
        op_name,
        request,
        DispatchContext(clock=clock, delegate=delegate),
    )


def _require_ok(handoff: Handoff, *, phase: str) -> dict[str, Any]:
    if handoff.outcome != "ok":
        error = handoff.content.get("error", "unknown")
        raise RuntimeError(f"{phase} failed: outcome={handoff.outcome} error={error}")
    return handoff.content


def _restore_request(state: dict[str, Any]) -> dict[str, Any]:
    power = state.get("state")
    if power == "off":
        return {"power": "off"}
    if power == "on":
        raise RuntimeError("original state is on; refusing to write")
    raise RuntimeError("original state is not off; refusing to write")


def _verify_state(
    actual: dict[str, Any],
    expected: dict[str, Any],
    *,
    phase: str,
) -> None:
    expected_power = expected.get("power")
    if expected_power == "off":
        if actual.get("state") != "off":
            raise RuntimeError(f"{phase} verification failed: light is not off")
        return
    if actual.get("state") != "on":
        raise RuntimeError(f"{phase} verification failed: light is not on")

    brightness = expected.get("brightness_pct")
    actual_brightness = actual.get("brightness_pct")
    if brightness is not None and (
        not isinstance(actual_brightness, int) or abs(actual_brightness - brightness) > 1
    ):
        raise RuntimeError(f"{phase} verification failed: brightness mismatch")
    color_temp = expected.get("color_temp_kelvin")
    actual_color_temp = actual.get("color_temp_kelvin")
    if color_temp is not None and (
        not isinstance(actual_color_temp, int)
        or isinstance(actual_color_temp, bool)
        or abs(actual_color_temp - color_temp) > 50
    ):
        raise RuntimeError(f"{phase} verification failed: color temperature mismatch")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply one explicit light change, verify it, then restore the original state.",
    )
    parser.add_argument("--power", choices=("on", "off"))
    parser.add_argument("--brightness-pct", type=int)
    parser.add_argument("--color-temp-kelvin", type=int)
    return parser


async def _run_live(apply_request: dict[str, Any] | None) -> dict[str, Any]:
    settings = Settings()
    base_url, token, entity_id = settings.require_home_assistant()
    async with httpx.AsyncClient() as client:
        adapter = HomeAssistantAdapter(
            HomeAssistantTransport(base_url, token, client=client),
            entity_id=entity_id,
        )
        return await run_smoke(
            adapter,
            RealClock(),
            apply_request=apply_request,
        )


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()
    request = {
        key: value
        for key, value in {
            "power": args.power,
            "brightness_pct": args.brightness_pct,
            "color_temp_kelvin": args.color_temp_kelvin,
        }.items()
        if value is not None
    }
    if args.apply and not request:
        parser.error("--apply requires at least one target value")
    if not args.apply and request:
        parser.error("target values require --apply")
    try:
        summary = asyncio.run(_run_live(request if args.apply else None))
    except Exception as exc:
        parser.exit(1, f"Home Assistant smoke failed: {exc}\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
