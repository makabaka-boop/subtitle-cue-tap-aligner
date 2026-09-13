from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_parse_endpoint_accepts_valid_schedule():
    response = client.post("/api/parse", json={"text": "A|0\nB|100"})
    body = response.json()
    assert body["valid"] is True
    assert body["cues"] == [
        {"text": "A", "time_ms": 0},
        {"text": "B", "time_ms": 100},
    ]


def test_parse_endpoint_locates_errors():
    response = client.post("/api/parse", json={"text": "A|0\n|-5\nB|0"})
    body = response.json()
    assert body["valid"] is False
    lines = {error["line"]: error["code"] for error in body["errors"]}
    assert lines[2] in {"EMPTY_SUBTITLE", "NEGATIVE_TIME"}
    assert 3 in lines


def test_match_endpoint_pairs_and_reports_leftovers():
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "A", "time_ms": 0},
                {"text": "B", "time_ms": 5000},
            ],
            "taps": [
                {"time_ms": 0, "seq": 0},
                {"time_ms": 12, "seq": 1},
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["pairs"][0]["cue_text"] == "A"
    assert body["pairs"][0]["deviation_ms"] == 0
    assert body["unmatched_cue_indices"] == [1]
    assert body["unmatched_tap_indices"] == [1]


def test_match_endpoint_allows_empty_cues():
    response = client.post(
        "/api/match",
        json={"cues": [], "taps": [{"time_ms": 0, "seq": 0}]},
    )
    assert response.status_code == 200
    assert response.json()["unmatched_tap_indices"] == [0]


def test_match_endpoint_rejects_invalid_cue_schedule():
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "A", "time_ms": 100},
                {"text": "B", "time_ms": 100},
            ],
            "taps": [],
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["errors"]
    assert detail["errors"][0]["line"] == 2


def test_match_endpoint_rejects_negative_taps():
    response = client.post(
        "/api/match",
        json={"cues": [], "taps": [{"time_ms": -1, "seq": 0}]},
    )
    assert response.status_code == 422


def test_huge_times_round_trip_as_exact_json_integers():
    base = 9_007_199_254_740_993  # 2**53 + 1
    parsed = client.post(
        "/api/parse", json={"text": f"甲|{base}\n乙|{base + 1}"}
    ).json()
    assert parsed["valid"] is True
    assert parsed["cues"][0]["time_ms"] == base
    assert parsed["cues"][1]["time_ms"] == base + 1

    matched = client.post(
        "/api/match",
        json={
            "cues": parsed["cues"],
            "taps": [{"time_ms": base + 1, "seq": 0}],
        },
    )
    assert matched.status_code == 200
    body = matched.json()
    assert body["pairs"][0]["cue_index"] == 1
    assert body["pairs"][0]["deviation_ms"] == 0
    assert body["pairs"][0]["cue_time_ms"] == base + 1


def test_request_without_anchor_returns_exactly_the_legacy_shape():
    payload = {
        "cues": [
            {"text": "A", "time_ms": 0},
            {"text": "B", "time_ms": 1000},
        ],
        "taps": [{"time_ms": 100, "seq": 0}, {"time_ms": 1100, "seq": 1}],
    }
    body = client.post("/api/match", json=payload).json()
    assert set(body) == {
        "pairs",
        "unmatched_cue_indices",
        "unmatched_tap_indices",
    }
    assert set(body["pairs"][0]) == {
        "cue_index",
        "cue_text",
        "cue_time_ms",
        "tap_index",
        "tap_seq",
        "tap_time_ms",
        "deviation_ms",
    }
    # Explicit empty anchors list behaves identically.
    body_empty = client.post(
        "/api/match", json={**payload, "anchors": []}
    ).json()
    assert body_empty == body


def test_anchor_calibrates_the_whole_run_and_reports_offset():
    base = 9_007_199_254_740_993  # 2**53 + 1
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "甲", "time_ms": base},
                {"text": "乙", "time_ms": base + 2_000_000},
            ],
            "taps": [
                {"time_ms": base + 150, "seq": 0},
                {"time_ms": base + 2_000_000 + 150, "seq": 1},
            ],
            "anchors": [{"cue_index": 0, "tap_index": 0}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["calibrated"] is True
    assert body["offset_ms"] == 150
    assert body["anchor_cue_index"] == 0
    assert body["anchor_tap_index"] == 0
    anchor = body["pairs"][0]
    assert anchor["deviation_ms"] == 150  # raw deviation kept
    assert anchor["calibrated_tap_time_ms"] == base
    assert anchor["calibrated_deviation_ms"] == 0
    other = body["pairs"][1]
    assert other["calibrated_tap_time_ms"] == base + 2_000_000
    assert other["calibrated_deviation_ms"] == 0


def test_anchor_out_of_range_is_rejected_with_400():
    response = client.post(
        "/api/match",
        json={
            "cues": [{"text": "A", "time_ms": 0}],
            "taps": [{"time_ms": 0, "seq": 0}],
            "anchors": [{"cue_index": 9, "tap_index": 0}],
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "ANCHOR_INDEX_OUT_OF_RANGE"
    assert detail["message"]


def test_negative_anchor_indices_are_rejected_like_other_out_of_range():
    # Negative cue/tap indices must surface the same 400 with the Chinese
    # anchor reason, not a generic English 422 validation error.
    for anchor in (
        {"cue_index": -1, "tap_index": 0},
        {"cue_index": 0, "tap_index": -1},
        {"cue_index": -2, "tap_index": -3},
    ):
        response = client.post(
            "/api/match",
            json={
                "cues": [{"text": "A", "time_ms": 0}],
                "taps": [{"time_ms": 0, "seq": 0}],
                "anchors": [anchor],
            },
        )
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["code"] == "ANCHOR_INDEX_OUT_OF_RANGE"
        assert "未重新对点" in detail["message"]


def test_duplicated_anchor_is_rejected_with_400():
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "A", "time_ms": 0},
                {"text": "B", "time_ms": 1000},
            ],
            "taps": [{"time_ms": 0, "seq": 0}, {"time_ms": 1000, "seq": 1}],
            "anchors": [
                {"cue_index": 0, "tap_index": 0},
                {"cue_index": 1, "tap_index": 1},
            ],
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "ANCHOR_DUPLICATED"


def test_anchor_not_in_raw_pairing_is_rejected_with_400():
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "A", "time_ms": 0},
                {"text": "B", "time_ms": 9000},
            ],
            "taps": [{"time_ms": 0, "seq": 0}, {"time_ms": 200, "seq": 1}],
            # cue 2 is never paired; tap 2 is unmatched too.
            "anchors": [{"cue_index": 1, "tap_index": 1}],
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "ANCHOR_NOT_PAIRED"


def test_huge_integer_offset_is_computed_exactly_over_http():
    shift = 9_007_199_254_740_993 + 12_345  # beyond double-safe range
    response = client.post(
        "/api/match",
        json={
            "cues": [
                {"text": "甲", "time_ms": shift},
                {"text": "乙", "time_ms": shift + 1_000_000},
            ],
            "taps": [
                {"time_ms": shift - 800, "seq": 0},
                {"time_ms": shift + 1_000_000 - 800, "seq": 1},
            ],
            "anchors": [{"cue_index": 0, "tap_index": 0}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["offset_ms"] == -800
    assert body["pairs"][0]["calibrated_tap_time_ms"] == shift
    assert body["pairs"][0]["calibrated_deviation_ms"] == 0
    assert body["pairs"][1]["calibrated_deviation_ms"] == 0

