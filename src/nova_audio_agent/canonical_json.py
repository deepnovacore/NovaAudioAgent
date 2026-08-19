"""Language-neutral canonical JSON used by migration fixtures.

Numbers follow ECMAScript ``JSON.stringify`` over binary64 values. Python's
``json.dumps`` uses different exponent thresholds and preserves negative zero,
so it cannot be used for cross-language golden bytes.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any


def canonical_json(value: Any) -> str:
    """Serialize one JSON value with sorted code-point keys and ECMAScript numbers."""
    return _serialize(value)


def canonical_json_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def _serialize(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _serialize_string(value)
    if isinstance(value, int | float):
        return _serialize_number(value)
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("canonical JSON object keys must be strings")
        fields = (f"{_serialize(key)}:{_serialize(value[key])}" for key in sorted(value))
        return "{" + ",".join(fields) + "}"
    raise TypeError(f"value is not JSON serializable: {type(value).__name__}")


def _serialize_string(value: str) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "".join(
        f"\\u{ord(character):04x}" if 0xD800 <= ord(character) <= 0xDFFF else character
        for character in encoded
    )


def _serialize_number(value: int | float) -> str:
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError("number is outside finite binary64 range") from exc
    if not math.isfinite(number):
        raise ValueError("number must be finite")
    if number == 0:
        return "0"

    sign = "-" if number < 0 else ""
    magnitude = abs(number)
    rendered = repr(magnitude)
    if "e" not in rendered and rendered.endswith(".0"):
        rendered = rendered[:-2]
    decimal = Decimal(rendered)
    digits = "".join(str(digit) for digit in decimal.as_tuple().digits)
    exponent = decimal.as_tuple().exponent
    if 1e-6 <= magnitude < 1e21:
        point = len(digits) + exponent
        if point <= 0:
            encoded = "0." + ("0" * -point) + digits
        elif point >= len(digits):
            encoded = digits + ("0" * (point - len(digits)))
        else:
            encoded = digits[:point] + "." + digits[point:]
        return sign + encoded

    scientific_exponent = len(digits) + exponent - 1
    coefficient = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    exponent_sign = "+" if scientific_exponent >= 0 else ""
    return f"{sign}{coefficient}e{exponent_sign}{scientific_exponent}"
