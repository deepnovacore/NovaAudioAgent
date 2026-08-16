from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


SCHEMA_VERSION = "realtime-probe.v1"
GateStatus = Literal["pass", "fail", "harness_invalid"]


@dataclass(slots=True)
class ScenarioStep:
    step_id: str
    kind: str
    text: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ProbeEvent:
    event_ref: str
    t_ms: int
    kind: str
    actor: str
    run_id: str
    delegate_id: str | None = None
    provider: dict[str, str] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> ProbeEvent:
        return cls(
            event_ref=str(value["event_ref"]),
            t_ms=int(value["t_ms"]),
            kind=str(value["kind"]),
            actor=str(value["actor"]),
            run_id=str(value["run_id"]),
            delegate_id=(
                str(value["delegate_id"]) if value.get("delegate_id") is not None else None
            ),
            provider={str(key): str(item) for key, item in value.get("provider", {}).items()},
            data=dict(value.get("data", {})),
        )


@dataclass(slots=True)
class HostState:
    run_id: str
    delegate_id: str
    delegate_status: str = "idle"
    snapshot_version: int = 0
    injected_progress_ids: list[str] = field(default_factory=list)
    spoken_progress_ids: list[str] = field(default_factory=list)
    interrupted_progress_ids: list[str] = field(default_factory=list)
    final_id: str | None = None
    final_result: str | None = None
    summary: str = ""

    def mark_injected(self, progress_id: str) -> None:
        if progress_id in self.injected_progress_ids:
            return
        self.injected_progress_ids.append(progress_id)
        self.snapshot_version += 1

    def mark_spoken(self, progress_id: str) -> None:
        if progress_id in self.interrupted_progress_ids:
            raise ValueError("progress already has a conflicting terminal disposition")
        if progress_id in self.spoken_progress_ids:
            return
        self.spoken_progress_ids.append(progress_id)
        self.snapshot_version += 1

    def mark_interrupted(self, progress_id: str) -> None:
        if progress_id in self.spoken_progress_ids:
            raise ValueError("progress already has a conflicting terminal disposition")
        if progress_id in self.interrupted_progress_ids:
            return
        self.interrupted_progress_ids.append(progress_id)
        self.snapshot_version += 1

    def recovery_projection(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "run_id": self.run_id,
            "delegate_id": self.delegate_id,
            "delegate_status": self.delegate_status,
            "snapshot_version": self.snapshot_version,
            "delivered_progress_ids": list(self.spoken_progress_ids),
            "interrupted_progress_ids": list(self.interrupted_progress_ids),
            "final_id": self.final_id,
            "final_result": self.final_result,
            "summary": self.summary,
        }


@dataclass(slots=True)
class GateResult:
    gate: int
    name: str
    status: GateStatus
    reason_codes: list[str] = field(default_factory=list)
    evidence_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ProbeReport:
    schema_version: str
    provider: str
    model: str
    phase: str
    run_id: str
    status: GateStatus
    gates: list[GateResult]
    metrics: dict[str, Any] = field(default_factory=dict)
    review_required: bool = True

    @classmethod
    def for_run(
        cls,
        *,
        provider: str,
        model: str,
        phase: str,
        run_id: str,
        gates: list[GateResult],
        metrics: dict[str, Any] | None = None,
    ) -> ProbeReport:
        statuses = {gate.status for gate in gates}
        status: GateStatus
        if "harness_invalid" in statuses:
            status = "harness_invalid"
        elif statuses == {"pass"}:
            status = "pass"
        else:
            status = "fail"
        return cls(
            schema_version=SCHEMA_VERSION,
            provider=provider,
            model=model,
            phase=phase,
            run_id=run_id,
            status=status,
            gates=list(gates),
            metrics=dict(metrics or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["gates"] = [gate.to_dict() for gate in self.gates]
        return value
