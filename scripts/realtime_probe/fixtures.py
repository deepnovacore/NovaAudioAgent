from __future__ import annotations

import hashlib
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from subprocess import CompletedProcess

from .scenario import (
    BARGE_IN_QUESTION,
    CONTEXT_FOLLOWUP,
    DELEGATE_REQUEST,
    HISTORY_RECOVERY_FOLLOWUP,
    PROVENANCE_QUESTION,
    RECOVERY_QUESTION,
)


FIXTURE_TEXT = {
    "delegate_request": DELEGATE_REQUEST,
    "provenance_question": PROVENANCE_QUESTION,
    "barge_in": BARGE_IN_QUESTION,
    "recovery_question": RECOVERY_QUESTION,
    "context_followup": CONTEXT_FOLLOWUP,
    "history_recovery_followup": HISTORY_RECOVERY_FOLLOWUP,
}


@dataclass(frozen=True, slots=True)
class AudioFixture:
    name: str
    path: Path
    text: str
    sha256: str
    bytes: int
    sample_rate: int = 16_000
    sample_width: int = 2
    channels: int = 1

    def to_dict(self) -> dict[str, object]:
        value = asdict(self)
        value["path"] = str(self.path)
        return value


def validate_pcm(path: Path, *, name: str | None = None, text: str = "") -> AudioFixture:
    payload = path.read_bytes()
    if not payload:
        raise ValueError(f"PCM fixture must be non-empty: {path}")
    if len(payload) % 2:
        raise ValueError(f"PCM fixture must contain aligned 16-bit samples: {path}")
    return AudioFixture(
        name=name or path.stem,
        path=path,
        text=text,
        sha256=hashlib.sha256(payload).hexdigest(),
        bytes=len(payload),
    )


CommandRunner = Callable[..., CompletedProcess[str]]


def build_fixtures(
    output_dir: Path,
    *,
    voice: str = "Tingting",
    command_runner: CommandRunner = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, AudioFixture]:
    say = which("say")
    ffmpeg = which("ffmpeg")
    if say is None:
        raise FileNotFoundError("required fixture tool is missing: say")
    if ffmpeg is None:
        raise FileNotFoundError("required fixture tool is missing: ffmpeg")
    output_dir.mkdir(parents=True, exist_ok=True)
    fixtures: dict[str, AudioFixture] = {}
    for name, text in FIXTURE_TEXT.items():
        aiff_path = output_dir / f"{name}.aiff"
        pcm_path = output_dir / f"{name}.pcm"
        command_runner(
            [say, "-v", voice, "-o", str(aiff_path), text],
            check=True,
            capture_output=True,
            text=True,
        )
        command_runner(
            [
                ffmpeg,
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(aiff_path),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(pcm_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        fixtures[name] = validate_pcm(pcm_path, name=name, text=text)
        aiff_path.unlink(missing_ok=True)
    return fixtures


def load_fixtures(directory: Path) -> dict[str, AudioFixture]:
    return {
        name: validate_pcm(directory / f"{name}.pcm", name=name, text=text)
        for name, text in FIXTURE_TEXT.items()
    }
