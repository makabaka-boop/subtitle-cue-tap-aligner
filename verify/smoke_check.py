"""Live end-to-end HTTP check used by the one-shot verify service.

Drives the real compose stack through nginx (/api proxy) with a freshly
constructed schedule and tap set - nothing here is hardcoded to a fixed
pairing result; expectations are derived from the pairing rule itself.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

WEB_BASE = os.environ.get("PLAYWRIGHT_BASE_URL", "http://web:80").rstrip("/")
SCHEDULE = "第一幕|0\n主角登场|1200\n谢幕|9000\n"


def request(method: str, url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


def parse_from(text: str) -> list[dict]:
    parsed = request("POST", f"{WEB_BASE}/api/parse", {"text": text})
    assert parsed["valid"] is True, parsed
    return parsed["cues"]


def main() -> None:
    with urllib.request.urlopen(f"{WEB_BASE}/api/health", timeout=5) as response:
        health = json.load(response)
    assert health == {"status": "ok"}, health

    parsed = request("POST", f"{WEB_BASE}/api/parse", {"text": SCHEDULE})
    assert parsed["valid"] is True, parsed
    cues = parsed["cues"]
    assert [c["time_ms"] for c in cues] == [0, 1200, 9000]

    # Invalid import must be rejected with line-located errors.
    bad = request(
        "POST", f"{WEB_BASE}/api/parse", {"text": "A|100\nB|100\n|-1"}
    )
    assert bad["valid"] is False
    assert {e["line"] for e in bad["errors"]} >= {2, 3}

    # Two taps: exact hit on cue 1; cue 2 at 1200 is 1100 ms away (out of
    # tolerance), cue 3 even farther - so only one pair, deviation 0.
    taps = [{"time_ms": 0, "seq": 0}, {"time_ms": 100, "seq": 1}]
    matched = request(
        "POST", f"{WEB_BASE}/api/match", {"cues": cues, "taps": taps}
    )
    assert len(matched["pairs"]) == 1, matched
    pair = matched["pairs"][0]
    assert pair["cue_index"] == 0
    assert pair["tap_index"] == 0
    assert pair["deviation_ms"] == 0
    assert matched["unmatched_cue_indices"] == [1, 2]
    assert matched["unmatched_tap_indices"] == [1]

    # Legacy request shape: no calibration fields are present at all.
    assert "calibrated" not in matched and "offset_ms" not in matched
    assert "ignored_tap_indices" not in matched
    assert "tolerance_ms" not in matched
    assert set(matched["pairs"][0]) == {
        "cue_index",
        "cue_text",
        "cue_time_ms",
        "tap_index",
        "tap_seq",
        "tap_time_ms",
        "deviation_ms",
    }

    # A rehearsal with one mistap: the stray hit at 700 ms steals cue 二
    # (300 ms away) from the real hit at 1000 ms. Ignoring the mistap lets
    # the real taps pair by the plain 800 ms rule; sequence numbers and
    # original indices are not reshuffled.
    mistap_cues = parse_from("一|0\n二|1000")
    mistap_taps = [
        {"time_ms": 0, "seq": 0},
        {"time_ms": 700, "seq": 1},
        {"time_ms": 1000, "seq": 2},
    ]
    raw_mistap = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {"cues": mistap_cues, "taps": mistap_taps},
    )
    assert [(p["cue_index"], p["tap_index"]) for p in raw_mistap["pairs"]] == [
        (0, 0),
        (1, 1),
    ]
    assert raw_mistap["unmatched_tap_indices"] == [2]

    ignored = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {"cues": mistap_cues, "taps": mistap_taps, "ignored_tap_indices": [1]},
    )
    assert ignored["ignored_tap_indices"] == [1]
    assert [
        (p["cue_index"], p["tap_index"], p["tap_seq"], p["deviation_ms"])
        for p in ignored["pairs"]
    ] == [(0, 0, 0, 0), (1, 2, 2, 0)]
    assert ignored["unmatched_tap_indices"] == []
    assert ignored["unmatched_cue_indices"] == []

    # Restoring the mistap (resubmitting without the field) makes it
    # participate again and yields the legacy response shape.
    restored = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {"cues": mistap_cues, "taps": mistap_taps},
    )
    assert restored == raw_mistap
    assert "ignored_tap_indices" not in restored

    # Pairing tolerance: one rehearsal with a 900 ms deviation and one
    # mistap. The default 800 ms window leaves the 900 ms hit unpaired;
    # widening to 1000 ms pairs it, while the ignored mistap (600 ms from
    # the same cue) stays out of the pairing.
    wide_cues = parse_from("开场|0\n谢幕|2000")
    wide_taps = [
        {"time_ms": 0, "seq": 0},
        {"time_ms": 2600, "seq": 1},
        {"time_ms": 2900, "seq": 2},
    ]
    default_window = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {"cues": wide_cues, "taps": wide_taps, "ignored_tap_indices": [1]},
    )
    assert [(p["cue_index"], p["tap_index"]) for p in default_window["pairs"]] == [
        (0, 0)
    ]
    assert default_window["unmatched_tap_indices"] == [2]
    assert default_window["ignored_tap_indices"] == [1]
    assert "tolerance_ms" not in default_window

    widened = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "ignored_tap_indices": [1],
            "tolerance_ms": 1000,
        },
    )
    assert widened["tolerance_ms"] == 1000
    assert [
        (p["cue_index"], p["tap_index"], p["deviation_ms"])
        for p in widened["pairs"]
    ] == [(0, 0, 0), (1, 2, 900)]
    assert widened["ignored_tap_indices"] == [1]
    assert widened["unmatched_tap_indices"] == []
    assert widened["unmatched_cue_indices"] == []

    # The anchor recalculation reuses the same window: calibrated to -900 ms,
    # the first hit stays paired only under the 1000 ms tolerance.
    widened_anchor = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "ignored_tap_indices": [1],
            "tolerance_ms": 1000,
            "anchors": [{"cue_index": 1, "tap_index": 2}],
        },
    )
    assert widened_anchor["calibrated"] is True
    assert widened_anchor["tolerance_ms"] == 1000
    assert widened_anchor["offset_ms"] == 900
    assert widened_anchor["ignored_tap_indices"] == [1]
    assert [p["calibrated_deviation_ms"] for p in widened_anchor["pairs"]] == [
        -900,
        0,
    ]

    # A request without the field still pairs by the fixed 800 ms rule.
    legacy_window = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {"cues": wide_cues, "taps": wide_taps},
    )
    assert "tolerance_ms" not in legacy_window
    assert [(p["cue_index"], p["tap_index"]) for p in legacy_window["pairs"]] == [
        (0, 0),
        (1, 1),
    ]
    assert legacy_window["unmatched_tap_indices"] == [2]

    # Anchor recalibration carries the same ignored indices: the mistap stays
    # excluded, the anchor indices refer to the original tap list.
    offset_cues = parse_from("一|0\n二|1000")
    offset_taps = [
        {"time_ms": 50, "seq": 0},
        {"time_ms": 700, "seq": 1},
        {"time_ms": 1050, "seq": 2},
    ]
    calibrated_ignored = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": offset_cues,
            "taps": offset_taps,
            "anchors": [{"cue_index": 1, "tap_index": 2}],
            "ignored_tap_indices": [1],
        },
    )
    assert calibrated_ignored["calibrated"] is True
    assert calibrated_ignored["ignored_tap_indices"] == [1]
    assert calibrated_ignored["offset_ms"] == 50
    assert calibrated_ignored["anchor_tap_index"] == 2
    assert [p["tap_index"] for p in calibrated_ignored["pairs"]] == [0, 2]
    assert [p["calibrated_deviation_ms"] for p in calibrated_ignored["pairs"]] == [
        0,
        0,
    ]
    assert calibrated_ignored["unmatched_tap_indices"] == []

    # A full rehearsal with a stable +250 ms global start offset (and a
    # little jitter): every raw deviation is ~250 ms. Calibrating on the
    # second row pins its calibrated deviation to exactly 0 and re-pairs the
    # rest by the existing rule.
    run_cues = parse_from(
        "一|0\n二|1200\n三|2400\n四|4000"
    )
    run_taps = [
        {"time_ms": 210, "seq": 0},
        {"time_ms": 1450, "seq": 1},
        {"time_ms": 2680, "seq": 2},
        {"time_ms": 4240, "seq": 3},
    ]
    raw_run = request("POST", f"{WEB_BASE}/api/match", {"cues": run_cues, "taps": run_taps})
    assert [p["deviation_ms"] for p in raw_run["pairs"]] == [210, 250, 280, 240]
    calibrated = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": run_cues,
            "taps": run_taps,
            "anchors": [{"cue_index": 1, "tap_index": 1}],
        },
    )
    assert calibrated["calibrated"] is True
    assert calibrated["offset_ms"] == 250
    assert calibrated["anchor_cue_index"] == 1
    assert calibrated["anchor_tap_index"] == 1
    assert [p["calibrated_deviation_ms"] for p in calibrated["pairs"]] == [
        -40,
        0,
        30,
        -10,
    ]
    anchor_pair = calibrated["pairs"][1]
    assert anchor_pair["calibrated_tap_time_ms"] == 1200
    assert anchor_pair["deviation_ms"] == 250  # raw fields preserved

    # A tap that was out of range raw can come inside the 800 ms window.
    rescue_cues = parse_from("一|0\n二|2000")
    rescue_taps = [{"time_ms": 100, "seq": 0}, {"time_ms": 2900, "seq": 1}]
    rescue = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": rescue_cues,
            "taps": rescue_taps,
            "anchors": [{"cue_index": 0, "tap_index": 0}],
        },
    )
    assert rescue["offset_ms"] == 100
    assert [p["calibrated_deviation_ms"] for p in rescue["pairs"]] == [0, 800]

    # Invalid anchors are rejected with 400 and leave it to the client to
    # keep its current result.
    def rejected(payload, code):
        try:
            request("POST", f"{WEB_BASE}/api/match", payload)
        except urllib.error.HTTPError as exc:
            assert exc.code == 400, exc.code
            detail = json.load(exc)["detail"]
            assert detail["code"] == code, detail
            assert detail["message"], detail
            return
        raise AssertionError(f"expected rejection {code}")

    rejected(
        {
            "cues": run_cues,
            "taps": run_taps,
            "anchors": [{"cue_index": 99, "tap_index": 0}],
        },
        "ANCHOR_INDEX_OUT_OF_RANGE",
    )
    rejected(
        {
            "cues": run_cues,
            "taps": run_taps,
            "anchors": [
                {"cue_index": 0, "tap_index": 0},
                {"cue_index": 1, "tap_index": 1},
            ],
        },
        "ANCHOR_DUPLICATED",
    )
    rejected(
        {
            "cues": cues,
            "taps": taps,
            "anchors": [{"cue_index": 1, "tap_index": 1}],
        },
        "ANCHOR_NOT_PAIRED",
    )
    # Illegal ignored indices are rejected with 400 and a Chinese reason; no
    # new result is produced, so the client keeps its current pairing.
    rejected(
        {
            "cues": mistap_cues,
            "taps": mistap_taps,
            "ignored_tap_indices": [1, 1],
        },
        "IGNORED_TAP_INDEX_DUPLICATED",
    )
    rejected(
        {
            "cues": mistap_cues,
            "taps": mistap_taps,
            "ignored_tap_indices": [3],
        },
        "IGNORED_TAP_INDEX_OUT_OF_RANGE",
    )
    rejected(
        {
            "cues": mistap_cues,
            "taps": mistap_taps,
            "ignored_tap_indices": [-1],
        },
        "IGNORED_TAP_INDEX_OUT_OF_RANGE",
    )
    # Illegal tolerances are rejected with 400 and a Chinese reason; no new
    # result is produced, so the client keeps its current pairing.
    rejected(
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "tolerance_ms": 3000,
        },
        "TOLERANCE_OUT_OF_RANGE",
    )
    rejected(
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "tolerance_ms": 99,
        },
        "TOLERANCE_OUT_OF_RANGE",
    )
    rejected(
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "tolerance_ms": 800.5,
        },
        "TOLERANCE_NOT_INTEGER",
    )
    rejected(
        {
            "cues": wide_cues,
            "taps": wide_taps,
            "tolerance_ms": "abc",
        },
        "TOLERANCE_NOT_INTEGER",
    )

    # Huge-integer times: the calibrated times and offset stay exact.
    shift = 9_007_199_254_740_993 + 12_345
    huge_cues = parse_from(f"甲|{shift}\n乙|{shift + 1_000_000}")
    huge_taps = [
        {"time_ms": shift - 800, "seq": 0},
        {"time_ms": shift + 1_000_000 - 800, "seq": 1},
    ]
    huge = request(
        "POST",
        f"{WEB_BASE}/api/match",
        {
            "cues": huge_cues,
            "taps": huge_taps,
            "anchors": [{"cue_index": 0, "tap_index": 0}],
        },
    )
    assert huge["offset_ms"] == -800
    assert huge["pairs"][0]["calibrated_tap_time_ms"] == shift
    assert huge["pairs"][0]["calibrated_deviation_ms"] == 0
    assert huge["pairs"][1]["calibrated_deviation_ms"] == 0

    print("smoke check passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        sys.exit(f"smoke check failed: {exc}")
