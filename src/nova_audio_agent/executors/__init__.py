"""Executor adapters. This round (phases A-C) has only the two simulators.

Real executors get onboarded one at a time starting from phase D, in
ascending order of irreversibility (search → HA → the car → codex →
AutoGLM, see 10-executor-onboarding.md).
"""

from nova_audio_agent.executors.sims import FastSim, SlowSim
from nova_audio_agent.executors.codex_live import CODEX_LIVE_MANIFEST, STEER, CodexLiveAdapter

__all__ = [
    "CODEX_LIVE_MANIFEST",
    "STEER",
    "CodexLiveAdapter",
    "FastSim",
    "SlowSim",
]
