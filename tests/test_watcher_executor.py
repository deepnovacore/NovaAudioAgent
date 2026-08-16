from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence

import pytest

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import WakeReason
from nova_audio_agent.executors.camera import Frame
from nova_audio_agent.executors import watcher as watcher_module
from nova_audio_agent.executors.watcher import GUARD_MANIFEST, WATCH_MANIFEST, WatchAdapter
from nova_audio_agent.media import MediaStore
from nova_audio_agent.model_gateway import GatewayCompletion, GatewayImage
from nova_audio_agent.ports import (
    DelegateRequest,
    DispatchContext,
    ObservationPayload,
    ProgressPayload,
    bind_delegate,
)


class _Frames:
    def __init__(self, frames: Sequence[Frame | None]) -> None:
        self._frames = list(frames)
        self.snapshots = 0

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def snapshot(self) -> Frame | None:
        index = min(self.snapshots, len(self._frames) - 1)
        self.snapshots += 1
        return self._frames[index]


class _Gateway:
    def __init__(self, responses: Sequence[str | BaseException]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, str, tuple[GatewayImage, ...]]] = []

    async def complete(
        self,
        *,
        model: str,
        system: str,
        prompt: str,
        json_schema: dict[str, object] | None = None,
        images: Sequence[GatewayImage] = (),
    ) -> GatewayCompletion:
        del system, json_schema
        self.calls.append((model, prompt, tuple(images)))
        response = self._responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return GatewayCompletion(response)


class _ConstantGateway(_Gateway):
    def __init__(self, response: str) -> None:
        super().__init__(())
        self._response = response

    async def complete(self, **kwargs: object) -> GatewayCompletion:
        model = kwargs["model"]
        prompt = kwargs["prompt"]
        images = kwargs.get("images", ())
        assert isinstance(model, str)
        assert isinstance(prompt, str)
        assert isinstance(images, tuple)
        self.calls.append((model, prompt, images))
        return GatewayCompletion(self._response)


class _GatedFrames(_Frames):
    def __init__(self, frame: Frame) -> None:
        super().__init__((frame,))
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def snapshot(self) -> Frame | None:
        self.entered.set()
        await self.release.wait()
        return await super().snapshot()


class _GatedGateway(_Gateway):
    def __init__(self, response: str) -> None:
        super().__init__((response,))
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def complete(self, **kwargs: object) -> GatewayCompletion:
        self.entered.set()
        await self.release.wait()
        return await super().complete(**kwargs)  # type: ignore[arg-type]


def _frame(serial: int) -> Frame:
    return Frame(
        payload=f"jpeg-{serial}".encode(),
        media_type="image/jpeg",
        width=640,
        height=480,
        captured_at=float(serial),
    )


def _context(
    manifest=WATCH_MANIFEST,
    *,
    clock: VirtualClock | None = None,
    progress: list[ProgressPayload] | None = None,
    observations: list[ObservationPayload] | None = None,
) -> DispatchContext:
    bound_clock = clock or VirtualClock()
    op = manifest.op("start")
    assert op is not None
    delegate = bind_delegate(
        DelegateRequest(
            executor=manifest.name,
            op="start",
            request={"condition": "水杯", "interval_s": 5.0, "duration_s": 60.0},
            origin_ref="conversation:1",
        ),
        wake_reason=WakeReason(kind="user_input", priority=100, routing_class="user_awaited"),
        op=op,
        now=bound_clock.now(),
        delegate_id=f"d-{manifest.name}-1",
    )
    return DispatchContext(
        clock=bound_clock,
        delegate=delegate,
        progress=None if progress is None else progress.append,
        observe=None if observations is None else observations.append,
    )


async def _drive(clock: VirtualClock, task: asyncio.Task[object]) -> None:
    for _ in range(5000):
        await asyncio.sleep(0)
        if task.done():
            return
        next_ts = clock.next_timer_ts()
        if next_ts is not None:
            clock.advance_to(next_ts)
    raise AssertionError("watch task did not settle")


async def _drive_until(clock: VirtualClock, predicate: Callable[[], bool]) -> None:
    for _ in range(1000):
        await asyncio.sleep(0)
        if predicate():
            return
        next_ts = clock.next_timer_ts()
        if next_ts is not None:
            clock.advance_to(next_ts)
    raise AssertionError("watch condition did not become true")


def test_manifests_separate_ordinary_and_urgent_monitoring() -> None:
    assert [op.name for op in WATCH_MANIFEST.ops] == ["start", "stop", "status"]
    assert all(op.readonly for op in WATCH_MANIFEST.ops)
    assert WATCH_MANIFEST.policy.priority == 40
    assert WATCH_MANIFEST.policy.wake == "surrogate"
    assert WATCH_MANIFEST.policy.suggest is True
    assert GUARD_MANIFEST.policy.priority == 90
    assert GUARD_MANIFEST.policy.wake == "fast"
    assert GUARD_MANIFEST.policy.suggest is False


def test_start_defaults_to_repeat_monitoring_for_thirty_minutes() -> None:
    assert watcher_module._normalize_start({"condition": "水杯"}) == ("水杯", 2.5, 1800.0)
    start_op = WATCH_MANIFEST.op("start")
    assert start_op is not None
    assert start_op.params["properties"]["interval_s"]["default"] == 2.5
    assert start_op.params["properties"]["duration_s"]["default"] == 1800
    assert "仅当用户明确指定" in start_op.params["properties"]["duration_s"]["description"]
    assert "省略" in start_op.params["properties"]["duration_s"]["description"]
    assert set(start_op.params["properties"]) == {"condition", "interval_s", "duration_s"}
    assert "重复" in start_op.description


def test_vlm_prompt_declares_strict_non_null_verdict_shape() -> None:
    assert '"hit": true 或 false' in watcher_module._SYSTEM
    assert '"observation": "可打印字符串"' in watcher_module._SYSTEM
    assert "禁止返回 null" in watcher_module._SYSTEM


def test_false_verdict_requires_an_empty_observation() -> None:
    with pytest.raises(ValueError, match="invalid verdict"):
        watcher_module.parse_watch_verdict('{"hit":false,"observation":"条件仍然存在"}')


async def test_configure_observation_ports_while_idle_applies_to_next_start() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    old_source = _Frames([None])
    old_gateway = _Gateway([])
    new_source = _Frames([_frame(1)])
    new_gateway = _Gateway(['{"hit":true,"observation":"桌面上有水杯"}'])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        old_source,
        old_gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )

    adapter.configure_observation_ports(source=new_source, gateway=new_gateway)
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯"},
            _context(clock=clock, observations=observations),
        )
    )
    await _drive_until(
        clock,
        lambda: any(item.content.get("hit") is True for item in observations),
    )
    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    handoff = await task

    assert handoff.content["state"] == "stopped"
    assert old_source.snapshots == 0
    assert old_gateway.calls == []
    assert new_source.snapshots == 1
    assert len(new_gateway.calls) == 1


async def test_configure_observation_ports_rejects_active_window_atomically() -> None:
    clock = VirtualClock()
    source = _Frames([_frame(1)])
    gateway = _Gateway(['{"hit":false,"observation":""}'])
    replacement_source = _Frames([_frame(2)])
    replacement_gateway = _Gateway(['{"hit":true,"observation":"replacement"}'])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=[]),
        )
    )
    await asyncio.sleep(0)

    with pytest.raises(RuntimeError, match="only change while idle"):
        adapter.configure_observation_ports(
            source=replacement_source,
            gateway=replacement_gateway,
        )

    assert adapter._source is source
    assert adapter._gateway is gateway
    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    await task


def test_watch_progress_summary_template_is_stable() -> None:
    assert watcher_module.WATCH_PROGRESS_SUMMARY_TEMPLATE.format(condition="水杯") == (
        "仍在监控：水杯"
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"condition": ""},
        {"condition": "x" * 201},
        {"condition": "cup", "interval_s": 1},
        {"condition": "cup", "interval_s": True},
        {"condition": "cup", "duration_s": 1801},
        {"condition": "cup", "extra": 1},
    ],
)
async def test_invalid_start_is_rejected_before_capture(payload: dict[str, object]) -> None:
    source = _Frames([_frame(1)])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        _Gateway(['{"hit":true,"observation":"cup"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )

    handoff = await adapter.dispatch("start", payload, _context())

    assert handoff.outcome == "failed"
    assert handoff.content == {"error": "invalid_params", "op": "start"}
    assert source.snapshots == 0


async def test_two_false_edges_rearm_and_second_hit_stays_non_terminal() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    source = _Frames([_frame(index) for index in range(1, 9)])
    gateway = _Gateway(
        [
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"桌面上出现水杯"}',
            '{"hit":true,"observation":"仍有水杯"}',
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"又出现"}',
            '{"hit":false,"observation":""}',
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"水杯再次出现"}',
        ]
    )
    media_ids = iter(("hit-1", "hit-2"))
    store = MediaStore(id_factory=lambda: next(media_ids))
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        gateway,
        store,
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": " 水杯 ", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive_until(clock, lambda: len(observations) == 9)

    hits = [item for item in observations if item.content.get("hit") is True]
    assert [item.content["hit_count"] for item in hits] == [1, 2]
    assert [item.content["media_ref"] for item in hits] == ["media:hit-1", "media:hit-2"]
    assert observations[0] == ObservationPayload(
        trust="trusted_system",
        content={"state": "armed", "condition": "水杯", "hit_count": 0},
    )
    assert observations[1] == ObservationPayload(
        trust="untrusted_external",
        content={
            "state": "hit",
            "hit": True,
            "condition": "水杯",
            "observation": "桌面上出现水杯",
            "media_ref": "media:hit-1",
            "hit_count": 1,
        },
    )
    assert [item.content["state"] for item in observations] == [
        "armed",
        "hit",
        "cooling",
        "waiting_reset",
        "cooling",
        "waiting_reset",
        "armed",
        "hit",
        "cooling",
    ]
    assert task.done() is False

    stopped = await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    terminal = await task

    assert stopped.content == {"stopped": True}
    assert terminal.content == {
        "hit": False,
        "state": "stopped",
        "reason": "stopped",
        "condition": "水杯",
        "hit_count": 2,
        "samples": 8,
    }
    assert source.snapshots == 8
    assert len(gateway.calls) == 8
    assert store.total_bytes == len(b"jpeg-2") + len(b"jpeg-8")


async def test_persistent_true_emits_one_hit_and_keeps_cooling() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _ConstantGateway('{"hit":true,"observation":"仍然可见"}'),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 2, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive_until(clock, lambda: adapter._status.samples >= 10)
    status = await adapter.dispatch("status", {}, _context(clock=clock))

    hits = [item for item in observations if item.content.get("hit") is True]
    assert len(hits) == 1
    assert [item.content["state"] for item in observations] == ["armed", "hit", "cooling"]
    assert status.content == {
        "op": "status",
        "state": "cooling",
        "condition": "水杯",
        "elapsed": 18.0,
        "samples": 10,
        "hit_count": 1,
        "reset_count": 0,
    }

    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    await task


async def test_contradictory_false_outputs_cannot_rearm_a_cooling_monitor() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(
            [
                '{"hit":true,"observation":"仍然可见"}',
                '{"hit":false,"observation":"其实仍然可见"}',
                '{"hit":false,"observation":"条件还在"}',
                '{"hit":true,"observation":"一直可见"}',
            ]
        ),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 2, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive_until(clock, lambda: adapter._status.samples >= 4)

    assert adapter._status.state == "cooling"
    assert adapter._status.reset_count == 0
    assert len([item for item in observations if item.content.get("hit") is True]) == 1
    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    await task


async def test_reset_evidence_survives_failures_but_true_clears_partial_reset() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    source = _Frames(
        [
            _frame(1),
            _frame(2),
            None,
            _frame(4),
            _frame(5),
            _frame(6),
            _frame(7),
            _frame(8),
            _frame(9),
            _frame(10),
            _frame(11),
        ]
    )
    gateway = _Gateway(
        [
            '{"hit":true,"observation":"一"}',
            '{"hit":false,"observation":""}',
            RuntimeError("temporary"),
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"二"}',
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"仍为二"}',
            '{"hit":false,"observation":""}',
            '{"hit":false,"observation":""}',
            '{"hit":true,"observation":"三"}',
        ]
    )
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 2, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive_until(
        clock,
        lambda: len([item for item in observations if item.content.get("hit") is True]) == 3,
    )

    assert [
        item.content["hit_count"] for item in observations if item.content.get("hit") is True
    ] == [1, 2, 3]
    assert [item.content["state"] for item in observations] == [
        "armed",
        "hit",
        "cooling",
        "waiting_reset",
        "armed",
        "hit",
        "cooling",
        "waiting_reset",
        "cooling",
        "waiting_reset",
        "armed",
        "hit",
        "cooling",
    ]

    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    await task


async def test_omitted_duration_runs_until_1800_seconds() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _ConstantGateway('{"hit":false,"observation":""}'),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯"},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive_until(clock, lambda: clock.waiter_count() == 1)
    clock.advance_to(1800.0)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert clock.now() == 1800.0
    assert (await task).content == {
        "hit": False,
        "state": "window_elapsed",
        "reason": "window_elapsed",
        "condition": "水杯",
        "hit_count": 0,
        "samples": 1,
    }


async def test_sampling_interval_is_measured_between_sample_starts() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []

    class _SlowGateway(_Gateway):
        def __init__(self) -> None:
            super().__init__(
                [
                    '{"hit":false,"observation":""}',
                    '{"hit":false,"observation":""}',
                    '{"hit":true,"observation":"命中"}',
                ]
            )
            self.started_at: list[float] = []

        async def complete(self, **kwargs: object) -> GatewayCompletion:
            self.started_at.append(clock.now())
            await clock.sleep(4.0)
            return await super().complete(**kwargs)  # type: ignore[arg-type]

    gateway = _SlowGateway()
    adapter = WatchAdapter(
        GUARD_MANIFEST,
        _Frames([_frame(1), _frame(2), _frame(3)]),
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "举起双手", "interval_s": 5, "duration_s": 60},
            _context(GUARD_MANIFEST, clock=clock, observations=observations),
        )
    )

    await _drive_until(
        clock,
        lambda: any(item.content.get("hit") is True for item in observations),
    )
    await adapter.dispatch("stop", {}, _context(GUARD_MANIFEST, clock=clock))
    await _drive(clock, task)

    assert (await task).content["state"] == "stopped"
    assert gateway.started_at == [0.0, 5.0, 10.0]


async def test_disabled_capture_fails_without_sampling() -> None:
    prepares = 0

    async def prepare() -> None:
        nonlocal prepares
        prepares += 1

    source = _Frames([_frame(1)])
    adapter = WatchAdapter(
        GUARD_MANIFEST,
        source,
        _Gateway([]),
        MediaStore(),
        model="watch-vl",
        capture_enabled=False,
        prepare_observation=prepare,
    )

    handoff = await adapter.dispatch(
        "start",
        {"condition": "火情"},
        _context(GUARD_MANIFEST),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content == {"error": "capture_unavailable"}
    assert source.snapshots == 0
    assert prepares == 0


async def test_repeat_start_requires_observation_port() -> None:
    source = _Frames([_frame(1)])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        _Gateway(['{"hit":true,"observation":"cup"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )

    handoff = await adapter.dispatch("start", {"condition": "水杯"}, _context())

    assert handoff.outcome == "unknown"
    assert handoff.content == {"error": "observation_unavailable"}
    assert source.snapshots == 0


async def test_watch_and_guard_instances_can_run_independently() -> None:
    watch_source = _GatedFrames(_frame(1))
    guard_source = _GatedFrames(_frame(2))
    watch = WatchAdapter(
        WATCH_MANIFEST,
        watch_source,
        _Gateway(['{"hit":false,"observation":""}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    guard = WatchAdapter(
        GUARD_MANIFEST,
        guard_source,
        _Gateway(['{"hit":false,"observation":""}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    watch_task = asyncio.create_task(
        watch.dispatch("start", {"condition": "水杯"}, _context(observations=[]))
    )
    guard_task = asyncio.create_task(
        guard.dispatch(
            "start",
            {"condition": "火情"},
            _context(GUARD_MANIFEST, observations=[]),
        )
    )
    await asyncio.gather(watch_source.entered.wait(), guard_source.entered.wait())

    assert watch._run_lock.locked()
    assert guard._run_lock.locked()
    await watch.dispatch("stop", {}, _context())
    await guard.dispatch("stop", {}, _context(GUARD_MANIFEST))
    watch_source.release.set()
    guard_source.release.set()

    assert (await watch_task).content["state"] == "stopped"
    assert (await guard_task).content["state"] == "stopped"


async def test_start_prepares_observation_after_admission_before_first_snapshot() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    events: list[tuple[str, bool, str]] = []

    class _OrderedFrames(_Frames):
        async def snapshot(self) -> Frame | None:
            events.append(("snapshot", adapter._run_lock.locked(), adapter._status.state))
            return await super().snapshot()

    async def prepare() -> None:
        events.append(("prepare", adapter._run_lock.locked(), adapter._status.state))

    source = _OrderedFrames([_frame(1)])
    adapter = WatchAdapter(
        GUARD_MANIFEST,
        source,
        _Gateway(['{"hit":true,"observation":"命中"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
        prepare_observation=prepare,
    )

    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "有人坐在沙发上"},
            _context(GUARD_MANIFEST, clock=clock, observations=observations),
        )
    )
    await _drive_until(
        clock,
        lambda: any(item.content.get("hit") is True for item in observations),
    )
    await adapter.dispatch("stop", {}, _context(GUARD_MANIFEST, clock=clock))
    await _drive(clock, task)
    handoff = await task

    assert handoff.content["state"] == "stopped"
    assert events == [
        ("prepare", True, "armed"),
        ("snapshot", True, "armed"),
    ]


async def test_prepare_observation_failure_is_capture_unavailable() -> None:
    source = _Frames([_frame(1)])

    async def prepare() -> None:
        raise RuntimeError("restart failed")

    adapter = WatchAdapter(
        GUARD_MANIFEST,
        source,
        _Gateway([]),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
        prepare_observation=prepare,
    )

    handoff = await adapter.dispatch(
        "start",
        {"condition": "有人坐在沙发上"},
        _context(GUARD_MANIFEST, observations=[]),
    )

    assert handoff.outcome == "unknown"
    assert handoff.content == {"error": "capture_unavailable"}
    assert source.snapshots == 0
    assert adapter._run_lock.locked() is False
    assert adapter._status.state == "idle"


async def test_stop_during_prepare_prevents_sampling_and_hit() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    observations: list[ObservationPayload] = []

    async def prepare() -> None:
        entered.set()
        await release.wait()

    source = _Frames([_frame(1)])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        _Gateway(['{"hit":true,"observation":"late"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
        prepare_observation=prepare,
    )
    ctx = _context(observations=observations)
    task = asyncio.create_task(adapter.dispatch("start", {"condition": "水杯"}, ctx))
    await entered.wait()

    await adapter.dispatch("stop", {}, _context())
    release.set()
    terminal = await task

    assert terminal.content["state"] == "stopped"
    assert source.snapshots == 0
    assert not any(item.content.get("hit") is True for item in observations)


async def test_stop_during_snapshot_prevents_classification_and_hit() -> None:
    observations: list[ObservationPayload] = []
    source = _GatedFrames(_frame(1))
    gateway = _Gateway(['{"hit":true,"observation":"late"}'])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch("start", {"condition": "水杯"}, _context(observations=observations))
    )
    await source.entered.wait()

    await adapter.dispatch("stop", {}, _context())
    source.release.set()
    terminal = await task

    assert terminal.content["state"] == "stopped"
    assert gateway.calls == []
    assert not any(item.content.get("hit") is True for item in observations)


async def test_stop_during_gateway_prevents_late_positive_publication() -> None:
    observations: list[ObservationPayload] = []
    gateway = _GatedGateway('{"hit":true,"observation":"late"}')
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch("start", {"condition": "水杯"}, _context(observations=observations))
    )
    await gateway.entered.wait()

    await adapter.dispatch("stop", {}, _context())
    gateway.release.set()
    terminal = await task

    assert terminal.content["state"] == "stopped"
    assert not any(item.content.get("hit") is True for item in observations)


async def test_stop_after_positive_classification_before_publication_prevents_hit() -> None:
    observations: list[ObservationPayload] = []
    verdict_ready = asyncio.Event()
    release = asyncio.Event()

    class _PostVerdictGateAdapter(WatchAdapter):
        async def _classify(self, frame: Frame, condition: str) -> watcher_module.WatchVerdict:
            verdict = await super()._classify(frame, condition)
            verdict_ready.set()
            await release.wait()
            return verdict

    adapter = _PostVerdictGateAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(['{"hit":true,"observation":"late"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch("start", {"condition": "水杯"}, _context(observations=observations))
    )
    await verdict_ready.wait()

    await adapter.dispatch("stop", {}, _context())
    release.set()
    terminal = await task

    assert terminal.content["state"] == "stopped"
    assert not any(item.content.get("hit") is True for item in observations)


async def test_prepare_crossing_window_deadline_cannot_start_sampling() -> None:
    clock = VirtualClock()
    entered = asyncio.Event()
    release = asyncio.Event()
    observations: list[ObservationPayload] = []

    async def prepare() -> None:
        entered.set()
        await release.wait()

    source = _Frames([_frame(1)])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        _Gateway(['{"hit":true,"observation":"late"}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
        prepare_observation=prepare,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "duration_s": 30},
            _context(clock=clock, observations=observations),
        )
    )
    await entered.wait()
    clock.advance_to(30.0)
    release.set()
    await _drive(clock, task)

    assert (await task).content["state"] == "window_elapsed"
    assert source.snapshots == 0
    assert [item.content["state"] for item in observations] == ["armed"]


async def test_snapshot_crossing_window_deadline_cannot_classify_or_publish() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    source = _GatedFrames(_frame(1))
    gateway = _Gateway(['{"hit":true,"observation":"late"}'])
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        source,
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "duration_s": 30},
            _context(clock=clock, observations=observations),
        )
    )
    await source.entered.wait()
    clock.advance_to(30.0)
    source.release.set()
    await _drive(clock, task)

    assert (await task).content["state"] == "window_elapsed"
    assert gateway.calls == []
    assert [item.content["state"] for item in observations] == ["armed"]


async def test_classification_crossing_window_deadline_cannot_publish_hit() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    gateway = _GatedGateway('{"hit":true,"observation":"late"}')
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        gateway,
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "duration_s": 30},
            _context(clock=clock, observations=observations),
        )
    )
    await gateway.entered.wait()
    clock.advance_to(30.0)
    gateway.release.set()
    await _drive(clock, task)

    assert (await task).content["state"] == "window_elapsed"
    assert [item.content["state"] for item in observations] == ["armed"]


@pytest.mark.parametrize("target_state", ["cooling", "waiting_reset"])
async def test_stop_from_repeat_lifecycle_states_emits_no_later_hit(target_state: str) -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    responses = (
        ['{"hit":true,"observation":"一"}']
        if target_state == "cooling"
        else ['{"hit":true,"observation":"一"}', '{"hit":false,"observation":""}']
    )
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(responses),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 2, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )
    await _drive_until(clock, lambda: adapter._status.state == target_state)
    hit_count = len([item for item in observations if item.content.get("hit") is True])

    await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    terminal = await task

    assert terminal.content["state"] == "stopped"
    assert len([item for item in observations if item.content.get("hit") is True]) == hit_count


async def test_stop_ends_running_window_and_status_is_synchronous() -> None:
    clock = VirtualClock()
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(['{"hit":false,"observation":""}'] * 4),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=[]),
        )
    )
    await asyncio.sleep(0)

    status = await adapter.dispatch("status", {}, _context(clock=clock))
    busy = await adapter.dispatch(
        "start",
        {"condition": "另一个条件"},
        _context(clock=clock),
    )
    after_busy = await adapter.dispatch("status", {}, _context(clock=clock))
    stopped = await adapter.dispatch("stop", {}, _context(clock=clock))
    await _drive(clock, task)
    terminal = await task

    assert status.outcome == "ok"
    assert status.content == {
        "op": "status",
        "state": "armed",
        "condition": "水杯",
        "elapsed": 0.0,
        "samples": 1,
        "hit_count": 0,
        "reset_count": 0,
    }
    assert busy.content == {"error": "busy", "op": "start"}
    assert after_busy.content == status.content
    assert stopped.content == {"stopped": True}
    assert terminal.content == {
        "hit": False,
        "state": "stopped",
        "reason": "stopped",
        "condition": "水杯",
        "hit_count": 0,
        "samples": 1,
    }
    idle = await adapter.dispatch("status", {}, _context(clock=clock))
    assert idle.content["state"] == "idle"


async def test_three_consecutive_capture_failures_are_terminal_unknown() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([None, None, None]),
        _Gateway([]),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive(clock, task)

    assert (await task).content == {"error": "capture_unavailable"}
    assert [item.content["state"] for item in observations] == ["armed"]


async def test_three_consecutive_invalid_verdicts_are_terminal_unknown() -> None:
    clock = VirtualClock()
    observations: list[ObservationPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1), _frame(2), _frame(3)]),
        _Gateway(["not-json", '{"hit":"yes","observation":"cup"}', RuntimeError("down")]),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=observations),
        )
    )

    await _drive(clock, task)

    assert (await task).content == {"error": "vlm_unavailable"}
    assert [item.content["state"] for item in observations] == ["armed"]


async def test_window_elapsed_and_heartbeat_use_virtual_time() -> None:
    clock = VirtualClock()
    progress: list[ProgressPayload] = []
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(['{"hit":false,"observation":""}'] * 5),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 10, "duration_s": 40},
            _context(clock=clock, progress=progress, observations=[]),
        )
    )

    await _drive(clock, task)
    handoff = await task

    assert handoff.content == {
        "hit": False,
        "state": "window_elapsed",
        "reason": "window_elapsed",
        "condition": "水杯",
        "hit_count": 0,
        "samples": 4,
    }
    assert progress == [
        ProgressPayload(
            phase="working",
            internal_activity=4,
            elapsed=30.0,
            summary="仍在监控：水杯",
        )
    ]


async def test_cancelling_start_releases_virtual_clock_waiter() -> None:
    clock = VirtualClock()
    adapter = WatchAdapter(
        WATCH_MANIFEST,
        _Frames([_frame(1)]),
        _Gateway(['{"hit":false,"observation":""}']),
        MediaStore(),
        model="watch-vl",
        capture_enabled=True,
    )
    task = asyncio.create_task(
        adapter.dispatch(
            "start",
            {"condition": "水杯", "interval_s": 5, "duration_s": 60},
            _context(clock=clock, observations=[]),
        )
    )
    for _ in range(10):
        await asyncio.sleep(0)
        if clock.waiter_count() == 1:
            break
    assert clock.waiter_count() == 1

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)

    assert clock.waiter_count() == 0
