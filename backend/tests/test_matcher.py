import random

import pytest

from app.matcher import MatchCue, MatchTap, TOLERANCE_MS, match


def cue(*spec):
    return [MatchCue(text=text, time_ms=time) for text, time in spec]


def tap(times):
    return [MatchTap(time_ms=time, seq=index) for index, time in enumerate(times)]


def pair_map(result):
    return {
        pair.cue_index: (pair.tap_index, pair.deviation_ms) for pair in result.pairs
    }


def test_exact_pairing():
    result = match(cue(("A", 0), ("B", 1000)), tap([0, 1000]))
    assert pair_map(result) == {0: (0, 0), 1: (1, 0)}
    assert result.unmatched_cue_indices == []
    assert result.unmatched_tap_indices == []


def test_nearest_cue_within_tolerance_is_chosen():
    # Tap at 900: cue0@0 is 900 away (out), cue1@1000 is 100 away.
    result = match(cue(("A", 0), ("B", 1000)), tap([900]))
    assert pair_map(result) == {1: (0, -100)}
    assert result.unmatched_cue_indices == [0]


@pytest.mark.parametrize("boundary", [-TOLERANCE_MS, TOLERANCE_MS])
def test_tolerance_is_inclusive_at_800_ms(boundary):
    result = match(cue(("A", 1000)), tap([1000 + boundary]))
    assert len(result.pairs) == 1
    assert result.pairs[0].deviation_ms == boundary


def test_801_ms_deviation_is_not_considered():
    result = match(cue(("A", 1000)), tap([1801]))
    assert result.pairs == []
    assert result.unmatched_cue_indices == [0]
    assert result.unmatched_tap_indices == [0]


def test_equal_absolute_deviation_prefers_earlier_cue():
    # Tap at 1000: cue0@900 and cue1@1100 are both 100 ms away.
    result = match(cue(("early", 900), ("late", 1100)), tap([1000]))
    assert result.pairs[0].cue_index == 0
    assert result.pairs[0].deviation_ms == 100


def test_each_cue_and_tap_used_at_most_once():
    # Two taps close to cue0 (800 apart); only one may take it.
    result = match(cue(("A", 0), ("B", 2000)), tap([700, 800]))
    assert len(result.pairs) == 1
    assert result.pairs[0].cue_index == 0
    assert result.pairs[0].tap_time_ms == 700  # taps processed ascending
    assert result.unmatched_tap_indices == [1]  # second tap: 800 to cue0 gone,
    #                                           1200 to cue1 out of range


def test_taps_are_processed_in_ascending_time_order():
    # Submitted out of order; the earliest tap claims cue0.
    result = match(
        cue(("A", 0), ("B", 1000)),
        [MatchTap(time_ms=1000, seq=0), MatchTap(time_ms=0, seq=1)],
    )
    mapping = pair_map(result)
    assert mapping[0] == (1, 0)
    assert mapping[1] == (0, 0)


def test_unmatched_entries_are_reported():
    result = match(cue(("A", 0), ("B", 5000)), tap([0, 10, 20]))
    assert pair_map(result) == {0: (0, 0)}
    assert result.unmatched_cue_indices == [1]
    # Unmatched taps listed in ascending time order.
    assert result.unmatched_tap_indices == [1, 2]


def test_pairs_are_returned_in_cue_script_order():
    result = match(cue(("A", 0), ("B", 1000), ("C", 2000)), tap([2000, 0, 1000]))
    assert [pair.cue_index for pair in result.pairs] == [0, 1, 2]


def test_empty_inputs():
    result = match([], [])
    assert result.model_dump() == {
        "pairs": [],
        "unmatched_cue_indices": [],
        "unmatched_tap_indices": [],
    }


def test_tie_between_cues_uses_earlier_time_not_list_order():
    # Earlier cue listed second in input: tie-break must still choose t=900.
    cues = [MatchCue(text="late", time_ms=1100), MatchCue(text="early", time_ms=900)]
    result = match(cues, [MatchTap(time_ms=1000, seq=0)])
    assert result.pairs[0].cue_index == 1
    assert result.pairs[0].cue_time_ms == 900


def test_matches_an_independently_implemented_reference():
    """The greedy rule re-derived with a slow, obviously-correct implementation."""
    rng = random.Random(20260913)
    for _ in range(300):
        cue_times = sorted(rng.sample(range(0, 20000), rng.randint(1, 12)))
        cues = cue(*[(f"C{i}", t) for i, t in enumerate(cue_times)])
        tap_times = [rng.randrange(-200, 20500) for _ in range(rng.randint(0, 14))]
        taps = [
            MatchTap(time_ms=max(t, 0), seq=i) for i, t in enumerate(tap_times)
        ]
        result = match(cues, taps)

        used_cues: set[int] = set()
        used_taps: set[int] = set()
        expected: dict[int, int] = {}
        for tap_index, tap in sorted(
            enumerate(taps), key=lambda item: (item[1].time_ms, item[1].seq)
        ):
            options = [
                (abs(tap.time_ms - cue.time_ms), cue.time_ms, cue_index)
                for cue_index, cue in enumerate(cues)
                if cue_index not in used_cues
                and abs(tap.time_ms - cue.time_ms) <= TOLERANCE_MS
            ]
            if not options:
                continue
            _, _, cue_index = min(options)
            used_cues.add(cue_index)
            used_taps.add(tap_index)
            expected[cue_index] = tap_index

        assert {pair.cue_index: pair.tap_index for pair in result.pairs} == expected
        assert set(result.unmatched_cue_indices) == set(range(len(cues))) - used_cues
        assert set(result.unmatched_tap_indices) == set(range(len(taps))) - used_taps
        for pair in result.pairs:
            assert (
                pair.deviation_ms == pair.tap_time_ms - pair.cue_time_ms
            )
