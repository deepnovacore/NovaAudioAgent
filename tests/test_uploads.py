from __future__ import annotations

import base64
from pathlib import Path

import pytest

from nova_audio_agent.media import MediaStore
from nova_audio_agent.uploads import UploadError, build_user_input, parse_attachment_input

_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def test_parse_attachment_input_supports_paths_spaces_and_literal_at() -> None:
    parsed = parse_attachment_input('比较 @one.png "@folder/two words.jpg" @@nova user@example.com')

    assert parsed.text == "比较 @nova user@example.com"
    assert parsed.paths == (Path("one.png"), Path("folder/two words.jpg"))


def test_build_user_input_validates_the_whole_batch_before_store_writes(
    tmp_path: Path,
) -> None:
    valid = tmp_path / "valid.png"
    valid.write_bytes(_PNG_1X1)
    invalid = tmp_path / "invalid.png"
    invalid.write_bytes(b"not-an-image")
    store = MediaStore()

    with pytest.raises(UploadError, match="无法解码"):
        build_user_input(
            f'看图 "@{valid}" "@{invalid}"',
            store=store,
            captured_at=3.0,
        )

    assert store.total_bytes == 0


def test_build_user_input_puts_only_refs_on_the_event(tmp_path: Path) -> None:
    image = tmp_path / "frame.png"
    image.write_bytes(_PNG_1X1)
    store = MediaStore(id_factory=lambda: "upload")

    event = build_user_input(
        f'这是什么 "@{image}"',
        store=store,
        captured_at=4.0,
    )

    assert event.text == "这是什么"
    assert event.media_refs == ("media:upload",)
    assert event.to_payload() == {"text": "这是什么", "media_refs": ["media:upload"]}
    assert str(image) not in repr(event)
    entry = store.peek("media:upload")
    assert entry is not None
    assert entry.media_type == "image/png"
    assert (entry.width, entry.height, entry.captured_at) == (1, 1, 4.0)


def test_build_user_input_rejects_an_extension_that_disagrees_with_content(
    tmp_path: Path,
) -> None:
    image = tmp_path / "pretend.jpg"
    image.write_bytes(_PNG_1X1)

    with pytest.raises(UploadError, match="扩展名与内容不一致"):
        build_user_input(
            f'"@{image}"',
            store=MediaStore(),
            captured_at=1.0,
        )
