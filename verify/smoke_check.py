"""Live end-to-end HTTP check used by the one-shot verify service.

Drives the real compose stack through nginx (/api proxy) with a freshly
constructed schedule and tap set - nothing here is hardcoded to a fixed
pairing result; expectations are derived from the pairing rule itself.
"""
from __future__ import annotations

import json
import os
import sys
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

    print("smoke check passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        sys.exit(f"smoke check failed: {exc}")
