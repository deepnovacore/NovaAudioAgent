"""Two simulators: one fast, one slow (05-executors.md).

| Simulator | Behavior | Purpose |
|---|---|---|
| fast_sim | Returns in milliseconds | Verifies "dispatch while speaking", verifies FastBrain chooses silence when eta is short |
| slow_sim | Controllable delay, can inject timeout and failure | Verifies "speak on timeout", verifies the wording for outcome=unknown |

The simulators are the only thing that makes "async doesn't block" and
"speak on timeout" **reproducible** — a real executor's delay is
uncontrollable, so those two core behaviors could never make it into CI
(D13).

## Three contracts (05-executors.md)

1. **dispatch never raises.** Transport errors, timeouts, invalid params, a
   nonexistent op — all of it becomes a Handoff with outcome=unknown |
   failed. **A bad output is an observation, not an exception.**
2. Every manifest has at least one readonly op (the recheck entry point for
   unknown)
3. One delegate produces exactly one handoff: the dispatch-exception,
   timeout, and success paths are mutually exclusive

## unknown and failed are kept strictly apart

- Timeout / transport interruption → **unknown**: we don't know whether the
  light actually got set. "Outcome unknown ≠ failure"
- Invalid params / nonexistent op → **failed**: it simply never happened

Calling unknown "failed" is exactly what the ironclad rule carried over from
v2 is meant to stop.

Both simulators have a non-readonly op (scenario 2 dispatches a light
change), so they are **not exceptions**: they share the same slot as real
executors, picked by NOVA_AUDIO_AGENT_EXECUTOR (R15). The startup-time
cardinality assertion is enforced by production assembly in Stage D0.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from nova_audio_agent.memory import HandoffPolicy, Outcome
from nova_audio_agent.ports import DispatchContext, ExecutorManifest, Handoff, OpSpec

# Which bad case to inject. None = returns normally.
Injection = Literal["timeout", "transport", "hang"]

SET_LIGHT = OpSpec(
    name="set_light",
    description="设置指定房间的灯光亮度",
    params={
        "type": "object",
        "properties": {"room": {"type": "string"}, "brightness": {"type": "integer"}},
        "required": ["room", "brightness"],
    },
    readonly=False,
    deadline_budget=10.0,
)
GET_STATE = OpSpec(
    name="get_state",
    description="读取指定房间当前的灯光状态",
    params={
        "type": "object",
        "properties": {"room": {"type": "string"}},
        "required": ["room"],
    },
    readonly=True,
    deadline_budget=5.0,
    # The light's actual brightness **is** the result of that set_light call,
    # and can be treated as conclusive (R13).
    verifies=("set_light",),
)

FAST_SIM_POLICY = HandoffPolicy(
    channel="fast_sim",
    priority=50,
    wake="fast",
    typical_latency=0.05,
    compress_watermark=20,
)
SLOW_SIM_POLICY = HandoffPolicy(
    channel="slow_sim",
    priority=50,
    wake="fast",
    typical_latency=5.0,
    compress_watermark=20,
)


_JSON_TYPES: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "object": dict,
    "array": list,
}


def check_params(schema: dict[str, Any], request: dict[str, Any]) -> list[str]:
    """Validates a request against the op's params schema, returns a list of
    problems (empty = passes).

    **Only checks required and the top-level type** — whether that's enough
    depends on phase C: that's when `compile_tool_schema` gets a real
    consumer, and that's the point to decide whether to pull in a dependency
    for full JSON Schema. Right now this layer exists so that
    `brightness="very dim"` doesn't sail through as `outcome=ok` — that would
    swap the "outcome unknown" failure mode for a **false success report**,
    which is worse than not validating at all.

    Validation lives in the adapter, not in the core: each executor pays for
    its own (the structural discipline of D23).
    """
    problems = [f"缺少必填参数 {key}" for key in schema.get("required", ()) if key not in request]
    for key, spec in schema.get("properties", {}).items():
        if key not in request:
            continue
        declared = spec.get("type")
        expected = _JSON_TYPES.get(declared)
        value = request[key]
        # bool is a subclass of int; don't let True pass as an integer.
        if declared in {"integer", "number"} and isinstance(value, bool):
            problems.append(f"{key} 应为 {declared}")
        elif expected is not None and not isinstance(value, expected):
            problems.append(f"{key} 应为 {declared}")
    return problems


class _Sim:
    """Shared implementation for both simulators. The only differences are
    latency and what can be injected."""

    def __init__(self, manifest: ExecutorManifest, *, latency: float) -> None:
        self.manifest = manifest
        self.latency = latency

    async def dispatch(self, op: str, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        spec = self.manifest.op(op)
        if spec is None:
            # The model hallucinates a nonexistent op → a failed observation, not an exception.
            return self._handoff("failed", {"error": "unknown_op", "op": op})

        problems = check_params(spec.params, request)
        if problems:
            return self._handoff("failed", {"error": "invalid_params", "problems": problems})

        return await self._run(spec, request, ctx)

    async def _run(self, spec: OpSpec, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        await ctx.clock.sleep(self.latency)
        return self._handoff("ok", {"op": spec.name, **request})

    def _handoff(self, outcome: Outcome, content: dict[str, Any]) -> Handoff:
        """Only fills in the three result fields. Identity (delegate_id /
        channel / origin_ref) is bound by the core — the simulator doesn't
        even get the chance to get it wrong (R46), it doesn't even need to
        look at ctx anymore.
        """
        return Handoff(outcome=outcome, trust="trusted_system", content=content)


class FastSim(_Sim):
    """Returns in milliseconds. FastBrain should choose to dispatch silently
    when eta is short."""

    def __init__(self, *, latency: float = 0.05) -> None:
        super().__init__(
            ExecutorManifest(
                name="fast_sim",
                ops=(SET_LIGHT, GET_STATE),
                policy=FAST_SIM_POLICY,
            ),
            latency=latency,
        )


class SlowSim(_Sim):
    """Controllable delay + can inject timeout / transport error / hang."""

    def __init__(self, *, latency: float = 5.0, inject: Injection | None = None) -> None:
        super().__init__(
            ExecutorManifest(
                name="slow_sim",
                ops=(SET_LIGHT, GET_STATE),
                policy=SLOW_SIM_POLICY,
            ),
            latency=latency,
        )
        self.inject = inject

    async def _run(self, spec: OpSpec, request: dict[str, Any], ctx: DispatchContext) -> Handoff:
        if self.inject == "hang":
            # Doesn't even return its own timeout. Only the core's deadline
            # timer can stop it (termination rule 2).
            await ctx.clock.sleep(math.inf)

        await ctx.clock.sleep(self.latency)

        if self.inject == "timeout":
            # A timeout isn't evidence that "this didn't happen": we don't
            # know whether the light actually got set.
            return self._handoff("unknown", {"error": "adapter_timeout", "op": spec.name})
        if self.inject == "transport":
            return self._handoff("unknown", {"error": "transport_error", "op": spec.name})
        return self._handoff("ok", {"op": spec.name, **request})
