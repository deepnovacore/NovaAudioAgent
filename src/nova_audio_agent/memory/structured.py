"""Structured State: three structs that update as the conversation progresses (02-memory.md, section 2).

**The sole writer is FastBrain's ActAct=update** (the writer itself is scheduled for B4; here we only
define the shape). There is no automatic reducer — whether a given handoff should rewrite Intent is a
judgment call, and judgment belongs to the model; writing a rule-based reducer would let heuristics seep
back into the core.

This round has **no base_revision, no CAS** (R3): per the port contract, there is no second writer to
begin with. revision is kept, monotonically increasing, bound by the runtime. See 02-memory.md for the
trigger conditions for bringing back CAS.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from nova_audio_agent.memory.items import MemoryRef


@dataclass(frozen=True, slots=True)
class Intent:
    """objective_hypothesis is a hypothesis, not a conclusion; unresolved_questions is one of the inputs
    to the suggestion pool."""

    objective_hypothesis: str = ""
    constraints: tuple[str, ...] = ()
    unresolved_questions: tuple[str, ...] = ()
    uncertainty: float = 1.0  # empty state = fully uncertain
    revision: int = 0


@dataclass(frozen=True, slots=True)
class Goal:
    objective: str = ""
    acceptance_criteria: tuple[str, ...] = ()
    status: Literal["accepted", "superseded"] = "accepted"
    revision: int = 0


@dataclass(frozen=True, slots=True)
class Authorization:
    """Session-level authorization profile, **not an execution gate** (D6).

    "The user has said it's fine to freely turn the living room light on and off" affects how FastBrain
    speaks and whether it dares to dispatch directly; it cannot substitute for the action-level
    confirmed_ref, or vice versa.
    """

    allow: tuple[str, ...] = ()
    deny: tuple[str, ...] = ()
    evidence_refs: tuple[MemoryRef, ...] = ()
    revision: int = 0


@dataclass(frozen=True, slots=True)
class StructuredState:
    """Field-level overwrite (R37): `update` only touches the fields named in the delta. ContextView
    reads it in full."""

    intent: Intent = Intent()
    goal: Goal = Goal()
    authorization: Authorization = Authorization()
