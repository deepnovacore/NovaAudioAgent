from __future__ import annotations

import pytest

from nova_audio_agent.memory import MemoryItem
from scripts.smoke_vision import build_parser, evaluate_smoke, vision_prompt

TRACE = "\n".join(
    (
        '{"kind":"user_input","payload":{}}',
        '{"kind":"model_done","payload":{"slot":"fast"}}',
        '{"kind":"handoff","payload":{"channel":"cam"}}',
        '{"kind":"model_done","payload":{"slot":"fast"}}',
    )
)
ACCEPTED = "PERSON=YES; GLASSES=YES; OBSERVED_AT=4.5"


def _cam_item() -> MemoryItem:
    return MemoryItem(
        channel="cam",
        seq=1,
        ts=5.0,
        trust="untrusted_external",
        priority=40,
        outcome="ok",
        content={
            "media_ref": "media:frame",
            "digest": "abc",
            "media_type": "image/jpeg",
            "width": 1280,
            "height": 720,
            "captured_at": 4.5,
        },
        refs=("conversation:1",),
    )


def test_evaluate_smoke_requires_person_glasses_time_and_hygienic_camera_evidence() -> None:
    report = evaluate_smoke(
        utterances=("我先看一下。", ACCEPTED),
        cam_items=(_cam_item(),),
        memory_text=repr((_cam_item(),)),
        trace_text=TRACE,
        forbidden_path="/private/tmp/camera.jpg",
    )

    assert report == {
        "passed": True,
        "person_seen": True,
        "glasses_seen": True,
        "observation_time_seen": True,
        "media_ref": "media:frame",
        "digest": "abc",
        "captured_at": 4.5,
        "answer": ACCEPTED,
    }


def test_live_smoke_prompt_contains_schema_but_not_expected_scene() -> None:
    assert "PERSON=<YES|NO|UNKNOWN>" in vision_prompt()
    assert "GLASSES=<YES|NO|UNKNOWN>" in vision_prompt()
    assert "PERSON=YES" not in vision_prompt()
    assert "GLASSES=YES" not in vision_prompt()
    args = build_parser().parse_args([])
    assert args.camera_index == 0
    assert args.timeout == 30.0


@pytest.mark.parametrize(
    ("answer", "error"),
    (
        ("PERSON=NO; GLASSES=YES; OBSERVED_AT=4.5", "没有识别到人"),
        ("PERSON=YES; GLASSES=NO; OBSERVED_AT=4.5", "没有识别到眼镜"),
        ("PERSON=UNKNOWN; GLASSES=UNKNOWN; OBSERVED_AT=4.5", "没有识别到人"),
        ("PERSON=YES; GLASSES=YES", "observation time"),
    ),
)
def test_evaluate_smoke_rejects_wrong_or_incomplete_scene(
    answer: str,
    error: str,
) -> None:
    with pytest.raises(RuntimeError, match=error):
        evaluate_smoke(
            utterances=(answer,),
            cam_items=(_cam_item(),),
            memory_text=repr((_cam_item(),)),
            trace_text=TRACE,
            forbidden_path="/private/tmp/camera.jpg",
        )


@pytest.mark.parametrize(
    "leak",
    (
        "data:image/jpeg;base64,",
        "/private/tmp/camera.jpg",
        "A" * 300,
    ),
)
def test_evaluate_smoke_rejects_trace_payload_or_path_leaks(leak: str) -> None:
    with pytest.raises(RuntimeError, match="trace 泄露"):
        evaluate_smoke(
            utterances=(ACCEPTED,),
            cam_items=(_cam_item(),),
            memory_text=repr((_cam_item(),)),
            trace_text=TRACE + f'\n{{"kind":"model_done","leak":"{leak}"}}',
            forbidden_path="/private/tmp/camera.jpg",
        )


def test_evaluate_smoke_rejects_memory_payload_leaks() -> None:
    with pytest.raises(RuntimeError, match="Memory 泄露"):
        evaluate_smoke(
            utterances=(ACCEPTED,),
            cam_items=(_cam_item(),),
            memory_text="data:image/jpeg;base64," + "A" * 300,
            trace_text=TRACE,
            forbidden_path="/private/tmp/camera.jpg",
        )


def test_evaluate_smoke_requires_camera_handoff_between_two_fastbrain_hops() -> None:
    with pytest.raises(RuntimeError, match="两跳"):
        evaluate_smoke(
            utterances=(ACCEPTED,),
            cam_items=(_cam_item(),),
            memory_text=repr((_cam_item(),)),
            trace_text="\n".join(
                (
                    '{"kind":"handoff","payload":{"channel":"cam"}}',
                    '{"kind":"model_done","payload":{"slot":"fast"}}',
                    '{"kind":"model_done","payload":{"slot":"fast"}}',
                )
            ),
            forbidden_path="/private/tmp/camera.jpg",
        )
