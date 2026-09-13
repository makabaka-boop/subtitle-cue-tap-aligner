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
