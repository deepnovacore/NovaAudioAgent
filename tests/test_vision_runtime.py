from __future__ import annotations

from nova_audio_agent.clock import VirtualClock
from nova_audio_agent.events import UserInput
from nova_audio_agent.executors.camera import CamAdapter, Frame, ScriptedFrameSource
from nova_audio_agent.executors.sims import FastSim
from nova_audio_agent.memory import Memory
from nova_audio_agent.media import MediaStore
from nova_audio_agent.ports import (
    ActionOutput,
    DelegateRequest,
    FastBrainOutput,
    SpeakOutput,
    SurrogateOutput,
)
from nova_audio_agent.runtime import Runtime
from nova_audio_agent.speech import RecordingSink

from fakes import ScriptedFastBrain, ScriptedSurrogate


async def test_runtime_looks_then_answers_with_the_camera_observation_time() -> None:
    clock = VirtualClock()
    store = MediaStore(id_factory=lambda: "frame")
    source = ScriptedFrameSource(
        Frame(
            payload=b"jpeg",
            media_type="image/jpeg",
            width=1280,
            height=720,
            captured_at=4.5,
        )
    )
    cam = CamAdapter(source, store)
    active = FastSim()
    fastbrain = ScriptedFastBrain(
        (
            FastBrainOutput(
                speak=SpeakOutput(act="none"),
                action=ActionOutput(
                    act="delegate",
                    delegate=DelegateRequest(
                        executor="cam",
                        op="snapshot",
                        request={},
                        origin_ref="conversation:1",
                    ),
                ),
            ),
            FastBrainOutput(
                speak=SpeakOutput(act="say", text="我看到 NOVA-CAM，观察于 t=4.5。"),
                action=ActionOutput(act="none"),
            ),
        ),
        clock=clock,
    )
    surrogate = ScriptedSurrogate(
        (SurrogateOutput(speak=True, reason="用户正在等视觉结果"),),
        clock=clock,
    )
    sink = RecordingSink(clock)
    runtime = Runtime(
        clock=clock,
        memory=Memory(policies=(cam.manifest.policy, active.manifest.policy)),
        fastbrain=fastbrain,
        surrogate=surrogate,
        executors={"cam": cam, "fast_sim": active},
        sink=sink,
    )
    runtime.post(UserInput("看看现在的画面"))

    await runtime.run()

    (observation,) = runtime.memory.channels["cam"].items
    assert observation.trust == "untrusted_external"
    assert observation.content["media_ref"] == "media:frame"
    assert observation.content["captured_at"] == 4.5
    assert sink.utterances() == ["我看到 NOVA-CAM，观察于 t=4.5。"]
    assert set(fastbrain.views[1].__dataclass_fields__) == {
        "structured",
        "channels",
        "in_flight",
        "affordances",
        "floor",
        "now",
        "trigger_kind",
    }
    assert b"jpeg" not in repr(runtime.memory).encode()
