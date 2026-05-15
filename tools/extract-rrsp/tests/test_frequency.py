import pytest

from frequency import parse_range, unit_to_hz_multiplier


@pytest.mark.parametrize(
    "raw, unit, expected_start, expected_end",
    [
        ("8.3 – 9", "kHz", 8_300, 9_000),
        ("8.3-9", "kHz", 8_300, 9_000),
        ("Below 8.3", "kHz", 0, 8_300),
        ("1 606.5 – 1 800", "kHz", 1_606_500, 1_800_000),
        ("87 – 88", "MHz", 87_000_000, 88_000_000),
        ("3 000 – 420 000", "GHz", 3_000_000_000_000, 420_000_000_000_000),
        ("135.7 – 137.8", "kHz", 135_700, 137_800),
    ],
)
def test_parse_range(raw, unit, expected_start, expected_end):
    start, end = parse_range(raw, unit)
    assert start == expected_start
    assert end == expected_end


def test_unit_to_hz_multiplier():
    assert unit_to_hz_multiplier("kHz") == 1_000
    assert unit_to_hz_multiplier("MHz") == 1_000_000
    assert unit_to_hz_multiplier("GHz") == 1_000_000_000


def test_unit_case_insensitive():
    assert unit_to_hz_multiplier("KHZ") == 1_000


def test_unknown_unit_raises():
    with pytest.raises(ValueError):
        unit_to_hz_multiplier("THz")


def test_unparseable_range_raises():
    with pytest.raises(ValueError):
        parse_range("not a range", "kHz")
