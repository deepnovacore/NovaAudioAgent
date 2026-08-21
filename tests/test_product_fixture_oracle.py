from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_product_manifest_sources_are_checkout_independent() -> None:
    manifest = json.loads((ROOT / "fixtures/product/v1/manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["entries"]:
        source = Path(entry["source"])
        assert not source.is_absolute()
        assert str(ROOT) not in entry["source"]


def test_product_fixture_check_does_not_drift_or_leak_a_different_checkout(
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "different-checkout"
    for relative in (
        "scripts/product_fixture_oracle.py",
        "src/nova_audio_agent",
        "tests/snapshots",
        "fixtures/runtime/v1",
        "fixtures/product/v1",
    ):
        source = ROOT / relative
        destination = checkout / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)
    result = subprocess.run(
        [sys.executable, "scripts/product_fixture_oracle.py", "check"],
        cwd=checkout,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    output = result.stdout + result.stderr
    assert str(checkout) not in output
    assert str(ROOT) not in output
