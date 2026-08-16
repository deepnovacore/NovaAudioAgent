"""Atomic local-image admission for the interactive Stage E transport."""

from __future__ import annotations

import io
import shlex
import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from nova_audio_agent.events import UserInput
from nova_audio_agent.media import MIB, MediaStore

MAX_UPLOAD_COUNT = 6
MAX_UPLOAD_ITEM_BYTES = 5 * MIB
MAX_UPLOAD_BATCH_BYTES = 16 * MIB
MAX_IMAGE_PIXELS = 16_777_216

_EXTENSION_FORMATS = {
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
}
_FORMAT_MEDIA_TYPES = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
}


class UploadError(ValueError):
    """A user-facing attachment admission failure."""


@dataclass(frozen=True, slots=True)
class ParsedAttachmentInput:
    text: str
    paths: tuple[Path, ...]


@dataclass(frozen=True, slots=True)
class PreparedUpload:
    payload: bytes
    media_type: str
    width: int
    height: int


def parse_attachment_input(line: str) -> ParsedAttachmentInput:
    try:
        tokens = shlex.split(line)
    except ValueError as exc:
        raise UploadError("附件输入的引号没有闭合") from exc
    text: list[str] = []
    paths: list[Path] = []
    for token in tokens:
        if token.startswith("@@"):
            text.append(token[1:])
        elif token.startswith("@") and len(token) > 1:
            paths.append(Path(token[1:]))
        else:
            text.append(token)
    return ParsedAttachmentInput(text=" ".join(text), paths=tuple(paths))


def build_user_input(
    line: str,
    *,
    store: MediaStore,
    captured_at: float,
) -> UserInput:
    parsed = parse_attachment_input(line)
    prepared = _prepare_batch(parsed.paths)
    refs = tuple(
        store.put(
            item.payload,
            media_type=item.media_type,
            width=item.width,
            height=item.height,
            captured_at=captured_at,
        ).ref
        for item in prepared
    )
    return UserInput(text=parsed.text, media_refs=refs)


def _prepare_batch(paths: tuple[Path, ...]) -> tuple[PreparedUpload, ...]:
    if len(paths) > MAX_UPLOAD_COUNT:
        raise UploadError(f"一条消息最多附加 {MAX_UPLOAD_COUNT} 张图片")
    sizes: list[int] = []
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise UploadError("附件必须是存在的普通文件")
        size = path.stat().st_size
        if size > MAX_UPLOAD_ITEM_BYTES:
            raise UploadError(f"单张图片不能超过 {MAX_UPLOAD_ITEM_BYTES // MIB} MiB")
        sizes.append(size)
    if sum(sizes) > MAX_UPLOAD_BATCH_BYTES:
        raise UploadError(f"一批图片不能超过 {MAX_UPLOAD_BATCH_BYTES // MIB} MiB")

    prepared: list[PreparedUpload] = []
    actual_total = 0
    for path in paths:
        expected_format = _EXTENSION_FORMATS.get(path.suffix.lower())
        if expected_format is None:
            raise UploadError("只支持 JPEG 和 PNG 图片")
        payload = path.read_bytes()
        actual_total += len(payload)
        if len(payload) > MAX_UPLOAD_ITEM_BYTES or actual_total > MAX_UPLOAD_BATCH_BYTES:
            raise UploadError("图片在读取过程中发生变化并超过上传上限")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(payload)) as image:
                    actual_format = image.format
                    width, height = image.size
                    image.verify()
        except (
            UnidentifiedImageError,
            OSError,
            SyntaxError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise UploadError("图片无法解码") from exc
        if actual_format != expected_format:
            raise UploadError("图片扩展名与内容不一致")
        if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
            raise UploadError("图片尺寸超出支持范围")
        prepared.append(
            PreparedUpload(
                payload=payload,
                media_type=_FORMAT_MEDIA_TYPES[actual_format],
                width=width,
                height=height,
            )
        )
    return tuple(prepared)
