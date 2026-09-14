"""Configurable pairing tolerance: matcher-level and API-level coverage.

A request may carry ``tolerance_ms`` (integer, 100–2000 ms) to replace the
fixed 800 ms candidate window for this pairing; the judging order —
ascending taps, single use, minimum absolute deviation, ties to the earlier
cue — is unchanged, and the response echoes the window actually used. A
request without the field pairs by the 800 ms rule and gets the legacy
response, field for field. Illegal tolerances are rejected with 400 and a
Chinese reason; no result is produced, so the page keeps what it shows.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.matcher import (
    MAX_TOLERANCE_MS,
    MIN_TOLERANCE_MS,
    TOLERANCE_MS,
    Anchor,
    AnchorRejected,
    MatchCue,
    MatchResult,
    MatchTap,
    ToleranceRejected,
    match,
    match_with_anchor,
)
from app.models import AnchorErrorCode, ToleranceErrorCode

client = TestClient(app)


def cue(*spec):
    return [MatchCue(text=text, time_ms=time) for text, time in spec]


def tap(times):
    return [MatchTap(time_ms=time, seq=index) for index, time in enumerate(times)]


def pair_map(result):
    return {
        pair.cue_index: (pair.tap_index, pair.deviation_ms) for pair in result.pairs
    }


# One rehearsal with a 900 ms deviation and one mistap: the stray hit at
# 2600 ms (600 ms from 谢幕) would steal cue 二 from the real hit at 2900 ms
# (900 ms away) once the window reaches 1000 ms, so it is flagged ignored.
CUES_900 = (("开场", 0), ("谢幕", 2000))
TAPS_900 = [0, 2600, 2900]


def test_default_window_leaves_a_900ms_deviation_unpaired():
    result = match(cue(*CUES_900), tap(TAPS_900), ignored_tap_indices=[1])
    assert pair_map(result) == {0: (0, 0)}
    assert result.unmatched_cue_indices == [1]
    assert result.unmatched_tap_indices == [2]
    assert result.ignored_tap_indices == [1]
    assert "tolerance_ms" not in result.model_dump()


def test_tolerance_1000_pairs_the_900ms_deviation_and_ignored_stays_out():
    result = match(
        cue(*CUES_900), tap(TAPS_900), ignored_tap_indices=[1], tolerance_ms=1000
    )
    # 谢幕 pairs the real hit at +900; the ignored mistap does not
    # participate even though it sits only 600 ms from the same cue.
    assert pair_map(result) == {0: (0, 0), 1: (2, 900)}
    assert [pair.tap_seq for pair in result.pairs] == [0, 2]
    assert result.ignored_tap_indices == [1]
    assert result.unmatched_tap_indices == []
    assert result.unmatched_cue_indices == []
    assert result.tolerance_ms == 1000


def test_without_the_ignored_flag_the_mistap_would_steal_the_cue_at_1000ms():
    # Sanity check on the scenario: the window alone does not fix the run —
    # ignoring the mistap is what keeps 谢幕 for the real hit.
    result = match(cue(*CUES_900), tap(TAPS_900), tolerance_ms=1000)
    assert pair_map(result) == {0: (0, 0), 1: (1, 600)}
    assert result.unmatched_tap_indices == [2]


def test_default_tolerance_is_800_and_window_is_inclusive():
    assert (MIN_TOLERANCE_MS, TOLERANCE_MS, MAX_TOLERANCE_MS) == (100, 800, 2000)
    for boundary in (-TOLERANCE_MS, TOLERANCE_MS):
        result = match(cue(("A", 1000)), tap([1000 + boundary]))
        assert len(result.pairs) == 1
    assert match(cue(("A", 1000)), tap([1000 + 801])).pairs == []


@pytest.mark.parametrize("window", [MIN_TOLERANCE_MS, 1000, MAX_TOLERANCE_MS])
def test_custom_window_is_inclusive_at_its_own_boundary(window):
    result = match(cue(("A", 5000)), tap([5000 + window]), tolerance_ms=window)
    assert len(result.pairs) == 1
    assert result.pairs[0].deviation_ms == window
    assert result.tolerance_ms == window
    out = match(cue(("A", 5000)), tap([5000 + window + 1]), tolerance_ms=window)
    assert out.pairs == []
    assert out.unmatched_tap_indices == [0]


def test_judging_order_is_unchanged_under_a_custom_window():
    cues = cue(("early", 900), ("late", 1100), ("taken", 1500))
    # Tie at 100 ms under the 1000 ms window: the earlier cue still wins.
    result = match(cues[:2], tap([1000]), tolerance_ms=1000)
    assert result.pairs[0].cue_index == 0
    assert result.pairs[0].cue_time_ms == 900
    # Ascending taps and single use: the first tap claims the only cue in
    # reach, the second gets nothing even though 1300 fits the window.
    result = match(cue(("A", 0)), tap([200, 1300]), tolerance_ms=1500)
    assert pair_map(result) == {0: (0, 200)}
    assert result.unmatched_tap_indices == [1]
    # Minimum deviation still beats a nearer-in-time but farther cue.
    result = match(cues, tap([1400]), tolerance_ms=1000)
    assert result.pairs[0].cue_index == 2  # 100 ms away, not 300/500


@pytest.mark.parametrize("bad", [99, 0, -1, 2001, 10000])
def test_out_of_range_tolerance_is_rejected(bad):
    with pytest.raises(ToleranceRejected) as exc:
        match(cue(("A", 0)), tap([0]), tolerance_ms=bad)
    assert exc.value.error.code is ToleranceErrorCode.TOLERANCE_OUT_OF_RANGE
    assert "100 至 2000" in exc.value.error.message


@pytest.mark.parametrize(
    "bad", [800.5, 800.0, "800", "abc", "", True, False, [800], {"ms": 800}]
)
def test_non_integer_tolerance_is_rejected(bad):
    with pytest.raises(ToleranceRejected) as exc:
        match(cue(("A", 0)), tap([0]), tolerance_ms=bad)
    assert exc.value.error.code is ToleranceErrorCode.TOLERANCE_NOT_INTEGER
    assert "整数" in exc.value.error.message


def test_no_tolerance_is_exactly_the_legacy_result():
    cues = cue(*CUES_900)
    taps = tap(TAPS_900)
    legacy = match(cues, taps)
    for absent in (None,):
        result = match(cues, taps, tolerance_ms=absent)
        assert type(result) is MatchResult
        assert result.model_dump() == legacy.model_dump()
        assert "tolerance_ms" not in result.model_dump()
    # An explicit 800 behaves like the default window but echoes the value.
    explicit = match(cues, taps, tolerance_ms=800)
    assert explicit.tolerance_ms == 800
    assert explicit.model_dump()["pairs"] == legacy.model_dump()["pairs"]


def test_tolerance_combines_with_ignored_indices_in_one_response():
    result = match(
        cue(*CUES_900), tap(TAPS_900), ignored_tap_indices=[1], tolerance_ms=1000
    )
    dumped = result.model_dump()
    assert dumped["tolerance_ms"] == 1000
    assert dumped["ignored_tap_indices"] == [1]
    # Tolerance alone: no ignored key; ignored alone: no tolerance key.
    only_tolerance = match(cue(*CUES_900), tap(TAPS_900), tolerance_ms=1000)
    assert "ignored_tap_indices" not in only_tolerance.model_dump()
    only_ignored = match(cue(*CUES_900), tap(TAPS_900), ignored_tap_indices=[1])
    assert "tolerance_ms" not in only_ignored.model_dump()


def test_anchor_recalibration_reuses_the_custom_window():
    cues = cue(*CUES_900)
    taps = tap(TAPS_900)
    # Under the default 800 ms window the 900 ms hit is not a raw pair, so
    # it cannot be an anchor at all.
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(
            cues, taps, [Anchor(cue_index=1, tap_index=2)], ignored_tap_indices=[1]
        )
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_NOT_PAIRED

    result = match_with_anchor(
        cues,
        taps,
        [Anchor(cue_index=1, tap_index=2)],
        ignored_tap_indices=[1],
        tolerance_ms=1000,
    )
    assert result.offset_ms == 900
    assert result.tolerance_ms == 1000
    assert result.ignored_tap_indices == [1]
    # The first hit calibrates to -900 ms: it stays paired only because the
    # recalibration ran with the 1000 ms window, not the 800 ms default.
    assert [pair.calibrated_deviation_ms for pair in result.pairs] == [-900, 0]
    assert result.unmatched_tap_indices == []
    assert result.unmatched_cue_indices == []


def test_anchor_without_tolerance_keeps_the_legacy_calibrated_shape():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([50, 1050])
    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert "tolerance_ms" not in result.model_dump()
    with pytest.raises(ToleranceRejected):
        match_with_anchor(
            cues, taps, [Anchor(cue_index=0, tap_index=0)], tolerance_ms=50
        )


def test_invalid_tolerance_is_rejected_before_the_anchor_is_checked():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([0, 1000])
    with pytest.raises(ToleranceRejected) as exc:
        match_with_anchor(
            cues,
            taps,
            [Anchor(cue_index=9, tap_index=9)],
            tolerance_ms="wide",
        )
    assert exc.value.error.code is ToleranceErrorCode.TOLERANCE_NOT_INTEGER


# --- HTTP layer -----------------------------------------------------------

PAYLOAD_900 = {
    "cues": [
        {"text": "开场", "time_ms": 0},
        {"text": "谢幕", "time_ms": 2000},
    ],
    "taps": [
        {"time_ms": 0, "seq": 0},
        {"time_ms": 2600, "seq": 1},
        {"time_ms": 2900, "seq": 2},
    ],
    "ignored_tap_indices": [1],
}


def test_endpoint_default_window_does_not_pair_the_900ms_deviation():
    response = client.post("/api/match", json=PAYLOAD_900)
    assert response.status_code == 200
    body = response.json()
    assert [(p["cue_index"], p["tap_index"]) for p in body["pairs"]] == [(0, 0)]
    assert body["unmatched_tap_indices"] == [2]
    assert body["ignored_tap_indices"] == [1]
    assert "tolerance_ms" not in body


def test_endpoint_tolerance_1000_pairs_and_echoes_the_window():
    response = client.post(
        "/api/match", json={**PAYLOAD_900, "tolerance_ms": 1000}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["tolerance_ms"] == 1000
    assert [
        (p["cue_index"], p["tap_index"], p["deviation_ms"]) for p in body["pairs"]
    ] == [(0, 0, 0), (1, 2, 900)]
    assert body["ignored_tap_indices"] == [1]
    assert body["unmatched_tap_indices"] == []
    assert body["unmatched_cue_indices"] == []


def test_endpoint_without_the_field_keeps_the_legacy_shape_and_800ms_rule():
    payload = {key: value for key, value in PAYLOAD_900.items() if key != "ignored_tap_indices"}
    body = client.post("/api/match", json=payload).json()
    assert set(body) == {"pairs", "unmatched_cue_indices", "unmatched_tap_indices"}
    # The 900 ms deviation is out of the fixed 800 ms window; the mistap at
    # 2600 ms (600 away) takes 谢幕 instead.
    assert [(p["cue_index"], p["tap_index"]) for p in body["pairs"]] == [
        (0, 0),
        (1, 1),
    ]
    assert body["unmatched_tap_indices"] == [2]
    # Explicit null behaves like an absent field.
    body_null = client.post("/api/match", json={**payload, "tolerance_ms": None}).json()
    assert body_null == body


@pytest.mark.parametrize("window", [100, 2000])
def test_endpoint_accepts_the_range_boundaries(window):
    response = client.post(
        "/api/match",
        json={
            "cues": [{"text": "A", "time_ms": 5000}],
            "taps": [{"time_ms": 5000 + window, "seq": 0}],
            "tolerance_ms": window,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["tolerance_ms"] == window
    assert body["pairs"][0]["deviation_ms"] == window


@pytest.mark.parametrize("bad", [99, 2001])
def test_endpoint_out_of_range_tolerance_gets_400_with_chinese_reason(bad):
    response = client.post(
        "/api/match", json={**PAYLOAD_900, "tolerance_ms": bad}
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "TOLERANCE_OUT_OF_RANGE"
    assert "100 至 2000" in detail["message"]
    assert "未进行配对" in detail["message"]


@pytest.mark.parametrize("bad", [800.5, "abc", "", True, [800]])
def test_endpoint_non_integer_tolerance_gets_400_with_chinese_reason(bad):
    response = client.post(
        "/api/match", json={**PAYLOAD_900, "tolerance_ms": bad}
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "TOLERANCE_NOT_INTEGER"
    assert "整数" in detail["message"]


def test_endpoint_anchor_recalculation_carries_and_echoes_the_tolerance():
    response = client.post(
        "/api/match",
        json={
            **PAYLOAD_900,
            "tolerance_ms": 1000,
            "anchors": [{"cue_index": 1, "tap_index": 2}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["calibrated"] is True
    assert body["tolerance_ms"] == 1000
    assert body["offset_ms"] == 900
    assert body["ignored_tap_indices"] == [1]
    assert [p["calibrated_deviation_ms"] for p in body["pairs"]] == [-900, 0]
    assert body["unmatched_tap_indices"] == []


def test_endpoint_invalid_tolerance_rejects_an_otherwise_valid_anchor_request():
    response = client.post(
        "/api/match",
        json={
            **PAYLOAD_900,
            "tolerance_ms": 5000,
            "anchors": [{"cue_index": 1, "tap_index": 2}],
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "TOLERANCE_OUT_OF_RANGE"
