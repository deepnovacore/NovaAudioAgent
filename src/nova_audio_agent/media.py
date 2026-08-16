"""Bounded image storage and deterministic request materialization for Stage E."""

from __future__ import annotations

import hashlib
import secrets
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from nova_audio_agent.context_view import ContextView

MIB = 1024 * 1024
MEDIA_STORE_MAX_BYTES = 32 * MIB
VISIBLE_FRAMES = 1
VISIBLE_ATTACHMENTS = 4
REQUEST_IMAGE_MAX_COUNT = 5
# Aggregate compressed payload bytes before Base64 expansion; this is the app request budget,
# not a claim about the provider's encoded wire-size limit.
REQUEST_IMAGE_MAX_BYTES = 12 * MIB

MediaRef = str
MediaSource = Literal["camera", "attachment"]
VisualState = Literal["attached", "record_only", "unavailable"]


@dataclass(frozen=True, slots=True)
class MediaEntry:
    ref: MediaRef
    digest: str
    media_type: str
    width: int
    height: int
    captured_at: float
    payload: bytes


class MediaStore:
    """In-process LRU bounded by compressed payload bytes."""

    def __init__(
        self,
        max_bytes: int = MEDIA_STORE_MAX_BYTES,
        *,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes 必须大于 0")
        self.max_bytes = max_bytes
        self._id_factory = id_factory or (lambda: secrets.token_hex(16))
        self._entries: OrderedDict[MediaRef, MediaEntry] = OrderedDict()
        self._total_bytes = 0

    @property
    def total_bytes(self) -> int:
        return self._total_bytes

    def put(
        self,
        payload: bytes,
        *,
        media_type: str,
        width: int,
        height: int,
        captured_at: float,
    ) -> MediaEntry:
        if not payload:
            raise ValueError("媒体 payload 不能为空")
        if len(payload) > self.max_bytes:
            raise ValueError("媒体 payload 超过 MediaStore 容量")
        if width <= 0 or height <= 0:
            raise ValueError("媒体尺寸必须为正数")
        ref = self._new_ref()
        entry = MediaEntry(
            ref=ref,
            digest=hashlib.sha256(payload).hexdigest(),
            media_type=media_type,
            width=width,
            height=height,
            captured_at=captured_at,
            payload=payload,
        )
        while self._entries and self._total_bytes + len(payload) > self.max_bytes:
            _, evicted = self._entries.popitem(last=False)
            self._total_bytes -= len(evicted.payload)
        self._entries[ref] = entry
        self._total_bytes += len(payload)
        return entry

    def get(self, ref: MediaRef) -> MediaEntry | None:
        entry = self._entries.get(ref)
        if entry is not None:
            self._entries.move_to_end(ref)
        return entry

    def peek(self, ref: MediaRef) -> MediaEntry | None:
        return self._entries.get(ref)

    def _new_ref(self) -> MediaRef:
        while True:
            ref = f"media:{self._id_factory()}"
            if ref not in self._entries:
                return ref


@dataclass(frozen=True, slots=True)
class ImageCandidate:
    ref: MediaRef
    source: MediaSource


@dataclass(frozen=True, slots=True)
class ImageBudget:
    max_images: int = REQUEST_IMAGE_MAX_COUNT
    max_bytes: int = REQUEST_IMAGE_MAX_BYTES


@dataclass(frozen=True, slots=True)
class MaterializedImage:
    ref: MediaRef
    media_type: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class MaterializedImages:
    images: tuple[MaterializedImage, ...]
    states: Mapping[MediaRef, VisualState]
    total_bytes: int


def select_image_candidates(
    view: ContextView,
    *,
    visible_frames: int = VISIBLE_FRAMES,
    visible_attachments: int = VISIBLE_ATTACHMENTS,
) -> tuple[ImageCandidate, ...]:
    camera: list[tuple[int, int, MediaRef]] = []
    attachments: list[tuple[int, int, MediaRef]] = []
    for channel in view.channels:
        for item in channel.recent:
            if channel.name == "cam":
                ref = item.content.get("media_ref")
                if isinstance(ref, str):
                    camera.append((item.seq, 0, ref))
            if channel.name == "conversation":
                refs = item.content.get("media_refs", ())
                if isinstance(refs, (list, tuple)):
                    attachments.extend(
                        (item.seq, position, ref)
                        for position, ref in enumerate(refs)
                        if isinstance(ref, str)
                    )
    camera.sort(reverse=True)
    attachments.sort(reverse=True)
    return (
        *(ImageCandidate(ref=ref, source="camera") for _, _, ref in camera[:visible_frames]),
        *(
            ImageCandidate(ref=ref, source="attachment")
            for _, _, ref in attachments[:visible_attachments]
        ),
    )


def materialize_images(
    view: ContextView,
    candidates: Iterable[ImageCandidate],
    store: MediaStore,
    *,
    budget: ImageBudget | None = None,
) -> MaterializedImages:
    limit = budget or ImageBudget()
    images: list[MaterializedImage] = []
    total_bytes = 0
    for candidate in candidates:
        # Probe with `peek`: `get` refreshes recency, and a candidate the budget is about
        # to drop is not "recently used" — letting it renew itself would keep an image the
        # model never sees alive at the expense of one it does.
        entry = store.peek(candidate.ref)
        if entry is None:
            continue
        size = len(entry.payload)
        if len(images) >= limit.max_images or total_bytes + size > limit.max_bytes:
            continue
        store.get(candidate.ref)  # Only what actually ships counts as used.
        images.append(
            MaterializedImage(
                ref=entry.ref,
                media_type=entry.media_type,
                payload=entry.payload,
            )
        )
        total_bytes += size

    attached = {image.ref for image in images}
    states = {
        ref: (
            "attached"
            if ref in attached
            else "record_only"
            if store.peek(ref) is not None
            else "unavailable"
        )
        for ref in _media_refs_in_view(view)
    }
    return MaterializedImages(
        images=tuple(images),
        # Read-only: the rest of this type is frozen, and a bare dict would be the one
        # field a consumer could quietly rewrite between rendering and assertion.
        states=MappingProxyType(states),
        total_bytes=total_bytes,
    )


def _media_refs_in_view(view: ContextView) -> tuple[MediaRef, ...]:
    refs: list[MediaRef] = []
    for channel in view.channels:
        for item in channel.recent:
            one = item.content.get("media_ref")
            if isinstance(one, str) and one not in refs:
                refs.append(one)
            many = item.content.get("media_refs", ())
            if isinstance(many, (list, tuple)):
                for ref in many:
                    if isinstance(ref, str) and ref not in refs:
                        refs.append(ref)
    return tuple(refs)
