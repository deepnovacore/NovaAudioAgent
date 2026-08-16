"""Floor three-state arbitration (A3 implementation-phase self-test).

⚠️ These do **not count as B2 turning green**. 09-roadmap.md lists "one test each
for Floor's three-line arbitration" under B2's green-turning items; what B2 tests
is its behavior once wired to the real sink and real suggestion pool, in scenario
2. This here is only to keep the Floor written in A from running naked into B2 —
in phase A, Floor is a pure decision function that only gives a verdict, without
caring where it lands.
"""

from __future__ import annotations

from nova_audio_agent.events import UserInput
from nova_audio_agent.floor import Floor
from nova_audio_agent.memory import USER_PRIORITY, Memory
from nova_audio_agent.runtime import wake_targets
from policies import SIM_POLICIES


def test_idle_lets_anyone_speak() -> None:
    assert Floor().decide(priority=1) == "allow"
    assert Floor().state == "idle"


def test_agent_speaking_yields_only_to_a_higher_priority() -> None:
    floor = Floor().on_speak_start("u-1", priority=50)

    assert floor.decide(priority=100) == "preempt"  # a more urgent one can preempt itself
    assert floor.decide(priority=50) == "defer"  # equal priority does not preempt
    assert floor.decide(priority=10) == "defer"


def test_user_speaking_always_defers() -> None:
    """This round is implemented as always defer. The two preconditions for relaxing it (barge-in / AI preemption) are in 08-deferred.md."""
    floor = Floor(state="user_speaking")

    assert floor.decide(priority=USER_PRIORITY + 1) == "defer"


def test_speak_end_of_a_preempted_utterance_does_not_free_the_floor() -> None:
    """A late speak_end for the utterance that got preempted does not count, otherwise it would inadvertently close out the new utterance."""
    floor = Floor().on_speak_start("u-1", priority=50).on_speak_start("u-2", priority=100)

    stale = floor.on_speak_end("u-1")
    assert stale.state == "agent_speaking"
    assert stale.utterance_id == "u-2"

    assert floor.on_speak_end("u-2").state == "idle"


def test_only_matching_user_speech_end_releases_user_floor() -> None:
    """An old agent terminal or foreign speech end must not release current user ownership."""
    floor = Floor().on_speak_start("u-agent", priority=50)
    floor = floor.on_user_speak_start("speech-user")

    assert floor.on_speak_end("u-agent") == floor
    assert floor.on_user_speak_end("speech-foreign") == floor
    assert floor.on_user_speak_end("speech-user") == Floor()


def test_priority_comes_from_the_wake_reason_not_from_the_model() -> None:
    """Priority is decided by the **triggering event**. The binding table is wake_targets; Floor only consumes it."""
    memory = Memory(policies=SIM_POLICIES)
    ((_slot, reason),) = wake_targets(UserInput(text="在吗"), memory)

    floor = Floor().on_speak_start("u-1", priority=50)

    assert reason.priority == USER_PRIORITY
    assert floor.decide(reason.priority) == "preempt"  # user input can always grab the floor
