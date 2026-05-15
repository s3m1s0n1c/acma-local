"""Frequency range and unit parsing for RRSP cells."""

from __future__ import annotations

import re

_RANGE_PATTERN = re.compile(
    r"(\d+(?:\s\d+)*(?:\.\d+)?)\s*[–\-]\s*(\d+(?:\s\d+)*(?:\.\d+)?)"
)
_BELOW_PATTERN = re.compile(r"^Below\s+(\d+(?:\s\d+)*(?:\.\d+)?)$", re.IGNORECASE)

_UNIT_MULTIPLIERS = {
    "khz": 1_000,
    "mhz": 1_000_000,
    "ghz": 1_000_000_000,
}


def unit_to_hz_multiplier(unit: str) -> int:
    try:
        return _UNIT_MULTIPLIERS[unit.lower()]
    except KeyError as e:
        raise ValueError(f"Unknown unit: {unit!r}") from e


def _strip_thousands(num_str: str) -> str:
    return re.sub(r"\s", "", num_str)


def _to_hz(num_str: str, multiplier: int) -> int:
    cleaned = _strip_thousands(num_str)
    if "." in cleaned:
        return int(round(float(cleaned) * multiplier))
    return int(cleaned) * multiplier


def parse_range(raw: str, unit: str) -> tuple[int, int]:
    multiplier = unit_to_hz_multiplier(unit)

    below = _BELOW_PATTERN.match(raw.strip())
    if below:
        return 0, _to_hz(below.group(1), multiplier)

    match = _RANGE_PATTERN.search(raw)
    if not match:
        raise ValueError(f"Could not parse frequency range: {raw!r}")
    start = _to_hz(match.group(1), multiplier)
    end = _to_hz(match.group(2), multiplier)
    return start, end
