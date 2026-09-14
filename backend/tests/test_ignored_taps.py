"""Ignoring mistaps: matcher-level and API-level coverage.

A mistap is excluded from the candidate taps before the rule runs; the
remaining taps keep their original indices and ``seq`` numbers (nothing is
reshuffled), pair by the ordinary 800 ms rule, and the result echoes the
actually ignored indices. Requests without the field get the legacy
response, field for field.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.matcher import (
    Anchor,
    AnchorRejected,
    IgnoredTapsRejected,
    MatchCue,
    MatchResult,
    MatchTap,
    match,
    match_with_anchor,
)
from app.models import AnchorErrorCode, IgnoredTapErrorCode

client = TestClient(app)


def cue(*spec):
    return [MatchCue(text=text, time_ms=time) for text, time in spec]


def tap(times):
    return [MatchTap(time_ms=time, seq=index) for index, time in enumerate(times)]


def pair_map(result):
    return {
        pair.cue_index: (pair.tap_index, pair.deviation_ms) for pair in result.pairs
    }


# A rehearsal with one mistap: the stray hit at 700 ms steals cue B (300 ms
# away) from the real hit at 1000 ms, which then has nothing left.
MISTAP_CUES = (("A", 0), ("B", 1000))
MISTAP_TAPS = [0, 700, 1000]


def test_mistap_steals_a_cue_in_the_raw_pairing():
    result = match(cue(*MISTAP_CUES), tap(MISTAP_TAPS))
    assert pair_map(result) == {0: (0, 0), 1: (1, -300)}
    assert result.unmatched_tap_indices == [2]


def test_ignored_mistap_is_excluded_and_real_taps_pair_by_the_800ms_rule():
    result = match(cue(*MISTAP_CUES), tap(MISTAP_TAPS), ignored_tap_indices=[1])
    # The real taps pair exactly by the rule: A<-0 (dev 0), B<-1000 (dev 0).
    assert pair_map(result) == {0: (0, 0), 1: (2, 0)}
    # Sequence numbers are not reshuffled: pairs still name 第1击/第3击.
    assert [pair.tap_seq for pair in result.pairs] == [0, 2]
    assert [pair.tap_index for pair in result.pairs] == [0, 2]
    # The ignored tap is reported separately, never as unmatched.
    assert result.ignored_tap_indices == [1]
    assert result.unmatched_tap_indices == []
    assert result.unmatched_cue_indices == []


def test_ignored_indices_are_returned_sorted_and_keep_original_times():
    cues = cue(("A", 0), ("B", 1000), ("C", 2000))
    taps = tap([10, 1000, 20, 2000])
    result = match(cues, taps, ignored_tap_indices=[2, 0])
    assert result.ignored_tap_indices == [0, 2]
    assert pair_map(result) == {1: (1, 0), 2: (3, 0)}
    assert result.unmatched_tap_indices == []


def test_no_ignored_indices_is_exactly_the_legacy_result():
    cues = cue(*MISTAP_CUES)
    taps = tap(MISTAP_TAPS)
    legacy = match(cues, taps)
    for absent in (None, []):
        result = match(cues, taps, ignored_tap_indices=absent)
        assert type(result) is MatchResult
        assert result.model_dump() == legacy.model_dump()
        assert "ignored_tap_indices" not in result.model_dump()


def test_all_taps_may_be_ignored():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([0, 1000])
    result = match(cues, taps, ignored_tap_indices=[0, 1])
    assert result.pairs == []
    assert result.unmatched_cue_indices == [0, 1]
    assert result.unmatched_tap_indices == []
    assert result.ignored_tap_indices == [0, 1]


def test_duplicate_ignored_indices_are_rejected():
    with pytest.raises(IgnoredTapsRejected) as exc:
        match(cue(("A", 0)), tap([0, 100]), ignored_tap_indices=[1, 1])
    assert exc.value.error.code is IgnoredTapErrorCode.IGNORED_TAP_INDEX_DUPLICATED
    assert "重复" in exc.value.error.message


def test_out_of_range_ignored_indices_are_rejected():
    cues = cue(("A", 0))
    taps = tap([0])
    for bad in ([1], [5], [-1], [0, -2]):
        with pytest.raises(IgnoredTapsRejected) as exc:
            match(cues, taps, ignored_tap_indices=bad)
        assert (
            exc.value.error.code
            is IgnoredTapErrorCode.IGNORED_TAP_INDEX_OUT_OF_RANGE
        )
        assert "超出本场敲击范围" in exc.value.error.message


def test_anchor_recalibration_excludes_the_same_ignored_taps():
    # Mistap at 700 ignored; the rest carries a stable +250 ms offset.
    cues = cue(("一", 0), ("二", 1000), ("三", 2000))
    taps = tap([0, 700, 1000, 2250])
    raw = match(cues, taps, ignored_tap_indices=[1])
    assert [pair.deviation_ms for pair in raw.pairs] == [0, 0, 250]

    result = match_with_anchor(
        cues,
        taps,
        [Anchor(cue_index=2, tap_index=3)],
        ignored_tap_indices=[1],
    )
    assert result.offset_ms == 250
    # Anchor indices still refer to the original tap list.
    assert result.anchor_tap_index == 3
    assert [pair.tap_index for pair in result.pairs] == [0, 2, 3]
    assert [pair.tap_seq for pair in result.pairs] == [0, 2, 3]
    assert [pair.calibrated_deviation_ms for pair in result.pairs] == [-250, -250, 0]
    assert result.ignored_tap_indices == [1]
    assert result.unmatched_tap_indices == []
    assert result.unmatched_cue_indices == []


def test_anchor_pointing_at_an_ignored_tap_is_not_a_raw_pair():
    cues = cue(*MISTAP_CUES)
    taps = tap(MISTAP_TAPS)
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(
            cues, taps, [Anchor(cue_index=1, tap_index=1)], ignored_tap_indices=[1]
        )
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_NOT_PAIRED


def test_invalid_ignored_indices_are_rejected_before_the_anchor_is_checked():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([0, 1000])
    with pytest.raises(IgnoredTapsRejected) as exc:
        match_with_anchor(
            cues, taps, [Anchor(cue_index=0, tap_index=0)], ignored_tap_indices=[1, 1]
        )
    assert exc.value.error.code is IgnoredTapErrorCode.IGNORED_TAP_INDEX_DUPLICATED


def test_anchor_without_ignored_indices_keeps_the_legacy_calibrated_shape():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([50, 1050])
    for absent in (None, []):
        result = match_with_anchor(
            cues, taps, [Anchor(cue_index=0, tap_index=0)], ignored_tap_indices=absent
        )
        assert "ignored_tap_indices" not in result.model_dump()


# --- HTTP layer -----------------------------------------------------------

MISTAP_PAYLOAD = {
    "cues": [
        {"text": "开场", "time_ms": 0},
        {"text": "谢幕", "time_ms": 1000},
    ],
    "taps": [
        {"time_ms": 0, "seq": 0},
        {"time_ms": 700, "seq": 1},
        {"time_ms": 1000, "seq": 2},
    ],
}


def test_match_endpoint_excludes_ignored_taps_and_echoes_them():
    response = client.post(
        "/api/match", json={**MISTAP_PAYLOAD, "ignored_tap_indices": [1]}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ignored_tap_indices"] == [1]
    assert [(p["cue_index"], p["tap_index"], p["tap_seq"]) for p in body["pairs"]] == [
        (0, 0, 0),
        (1, 2, 2),
    ]
    assert [p["deviation_ms"] for p in body["pairs"]] == [0, 0]
    assert body["unmatched_tap_indices"] == []
    assert body["unmatched_cue_indices"] == []


def test_response_carries_ignored_indices_only_when_the_request_does():
    legacy = client.post("/api/match", json=MISTAP_PAYLOAD).json()
    assert "ignored_tap_indices" not in legacy
    assert set(legacy) == {"pairs", "unmatched_cue_indices", "unmatched_tap_indices"}

    empty = client.post(
        "/api/match", json={**MISTAP_PAYLOAD, "ignored_tap_indices": []}
    ).json()
    assert empty == legacy

    with_ignored = client.post(
        "/api/match", json={**MISTAP_PAYLOAD, "ignored_tap_indices": [1]}
    ).json()
    assert with_ignored["ignored_tap_indices"] == [1]


def test_restoring_a_mistap_makes_it_participate_again():
    # Re-submitting without the index is the restore path: the mistap is
    # back in the candidate taps and pairs (or stays unmatched) by the rule.
    restored = client.post("/api/match", json=MISTAP_PAYLOAD).json()
    assert [(p["cue_index"], p["tap_index"]) for p in restored["pairs"]] == [
        (0, 0),
        (1, 1),
    ]
    assert restored["unmatched_tap_indices"] == [2]
    assert "ignored_tap_indices" not in restored


def test_duplicate_ignored_indices_get_400_with_chinese_reason():
    response = client.post(
        "/api/match", json={**MISTAP_PAYLOAD, "ignored_tap_indices": [1, 1]}
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "IGNORED_TAP_INDEX_DUPLICATED"
    assert "重复" in detail["message"]
    assert "未进行配对" in detail["message"]


def test_out_of_range_ignored_indices_get_400_with_chinese_reason():
    for bad in ([3], [99], [-1]):
        response = client.post(
            "/api/match", json={**MISTAP_PAYLOAD, "ignored_tap_indices": bad}
        )
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["code"] == "IGNORED_TAP_INDEX_OUT_OF_RANGE"
        assert "超出本场敲击范围" in detail["message"]


def test_anchor_recalculation_carries_the_same_ignored_indices():
    payload = {
        "cues": [
            {"text": "一", "time_ms": 0},
            {"text": "二", "time_ms": 1000},
            {"text": "三", "time_ms": 2000},
        ],
        "taps": [
            {"time_ms": 0, "seq": 0},
            {"time_ms": 700, "seq": 1},
            {"time_ms": 1000, "seq": 2},
            {"time_ms": 2250, "seq": 3},
        ],
        "anchors": [{"cue_index": 2, "tap_index": 3}],
        "ignored_tap_indices": [1],
    }
    response = client.post("/api/match", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["calibrated"] is True
    assert body["ignored_tap_indices"] == [1]
    assert body["offset_ms"] == 250
    assert body["anchor_tap_index"] == 3
    assert [p["tap_index"] for p in body["pairs"]] == [0, 2, 3]
    assert [p["calibrated_deviation_ms"] for p in body["pairs"]] == [-250, -250, 0]
    assert body["unmatched_tap_indices"] == []


def test_invalid_ignored_indices_reject_an_otherwise_valid_anchor_request():
    payload = {
        "cues": [{"text": "一", "time_ms": 0}, {"text": "二", "time_ms": 1000}],
        "taps": [{"time_ms": 0, "seq": 0}, {"time_ms": 1000, "seq": 1}],
        "anchors": [{"cue_index": 0, "tap_index": 0}],
        "ignored_tap_indices": [7],
    }
    response = client.post("/api/match", json=payload)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "IGNORED_TAP_INDEX_OUT_OF_RANGE"


def test_ignored_indices_are_validated_against_this_sessions_taps():
    # Two taps in this session; index 2 belongs to a longer previous run.
    payload = {
        "cues": [{"text": "一", "time_ms": 0}],
        "taps": [{"time_ms": 0, "seq": 0}, {"time_ms": 5, "seq": 1}],
        "ignored_tap_indices": [2],
    }
    response = client.post("/api/match", json=payload)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "IGNORED_TAP_INDEX_OUT_OF_RANGE"
