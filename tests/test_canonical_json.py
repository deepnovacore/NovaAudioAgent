from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from nova_audio_agent.canonical_json import canonical_json, canonical_json_bytes


VECTOR_PATH = Path(__file__).parents[1] / "fixtures" / "runtime" / "canonical-json-vectors.json"


def test_shared_canonical_json_vectors_match_ecmascript_bytes() -> None:
    vectors = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    for vector in vectors:
        assert canonical_json(vector["value"]) == vector["canonical"], vector["id"]
        assert canonical_json_bytes(vector["value"]) == vector["canonical"].encode()


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 10**400])
def test_canonical_json_rejects_non_finite_binary64_numbers(value: object) -> None:
    with pytest.raises(ValueError, match="finite"):
        canonical_json({"bad": value})


def test_canonical_json_rejects_non_string_keys_and_non_json_values() -> None:
    with pytest.raises(TypeError, match="keys"):
        canonical_json({1: "bad"})
    with pytest.raises(TypeError, match="not JSON serializable"):
        canonical_json({"bad": object()})
