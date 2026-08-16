"""Channel policies for tests: re-exported from the two simulators, plus one ambient channel that only lives in tests.

The two simulators' **official** manifests are scheduled for Phase C (spelled out in 05-executors.md);
by then the sole authority for policy will be ExecutorManifest.policy -- which is already true now as well,
this module just gives tests a short name for it.
"""

from __future__ import annotations

from nova_audio_agent.executors.sims import FAST_SIM_POLICY, SLOW_SIM_POLICY
from nova_audio_agent.memory import HandoffPolicy

# The channel with `wake="surrogate"`. The sole trigger source for scenario 4, since both simulators
# are `wake="fast"` -- without it, the `surrogate.watch` slot never wakes even once in the whole test suite.
#
# **Don't add a third executor to sims.py for this**: that would need a manifest, a set of ops, and a
# dispatch implementation, and scenario 4 never dispatches its work anyway -- all it needs is "one
# observation that doesn't go through FastBrain." An executor that's never dispatched would just be
# building something into the test that doesn't exist on the production path.
#
# priority=10 sits below USER_PRIORITY(100) and both simulators (50): ambient happenings in the
# environment shouldn't have standing to interrupt the user, and this is exactly the source of the
# proactive-hop speak priority (R36).
AMBIENT_POLICY = HandoffPolicy(
    channel="ambient",
    priority=10,
    wake="surrogate",
    typical_latency=1.0,
    compress_watermark=20,
)

SIM_POLICIES = (FAST_SIM_POLICY, SLOW_SIM_POLICY)

__all__ = ["AMBIENT_POLICY", "FAST_SIM_POLICY", "SIM_POLICIES", "SLOW_SIM_POLICY"]
