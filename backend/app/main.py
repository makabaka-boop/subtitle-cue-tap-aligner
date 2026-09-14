"""FastAPI application for the subtitle cue-point station."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .matcher import (
    Anchor,
    AnchorRejected,
    IgnoredTapsRejected,
    MatchCue,
    MatchResult,
    MatchTap,
    ToleranceRejected,
    match,
    match_with_anchor,
)
from .parser import ParseResponse, parse_schedule

app = FastAPI(title="字幕对点台 API", version="1.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ParseRequest(BaseModel):
    text: str


class MatchRequest(BaseModel):
    cues: list[MatchCue] = []
    taps: list[MatchTap] = []
    # Optional: a single already-paired row used as the calibration anchor.
    # Absent/empty => the raw pairing, byte-for-byte compatible with 1.0.
    anchors: list[Anchor] | None = None
    # Optional: indices of taps flagged as mistaps to exclude from pairing.
    # Absent/empty => nothing ignored and the response keeps the legacy
    # shape (no ignored_tap_indices key). No ge=0 bound on purpose: a
    # negative index must surface the Chinese out-of-range reason (400),
    # not a generic Pydantic 422.
    ignored_tap_indices: list[int] | None = None
    # Optional: pairing tolerance in ms (integer, 100–2000) replacing the
    # fixed 800 ms candidate window for this request. Deliberately untyped
    # (Any): a non-integer or out-of-range value must surface the Chinese
    # reason (400), not a generic Pydantic 422. Absent/null => the 800 ms
    # window applies and the response keeps the legacy shape (no
    # tolerance_ms key).
    tolerance_ms: Any = None


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/parse", response_model=ParseResponse)
def parse_endpoint(request: ParseRequest) -> ParseResponse:
    """Validate a schedule import; errors are located to concrete lines."""
    return parse_schedule(request.text)


def _revalidate_cues(cues: list[MatchCue]) -> None:
    """Re-validate cues server side before any pairing."""
    if not cues:
        return
    schedule = "\n".join(f"{cue.text}|{cue.time_ms}" for cue in cues)
    parsed = parse_schedule(schedule)
    if not parsed.valid:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "计划时间表无效，未进行配对",
                "errors": [error.model_dump() for error in parsed.errors],
            },
        )


@app.post("/api/match")
def match_endpoint(request: MatchRequest):
    """Pair cues with taps, optionally ignoring mistaps, calibrating the run
    on one anchor row, and/or applying an explicit pairing tolerance.

    Without ignored indices, an anchor or a tolerance the response is exactly
    the legacy result. Carrying ``ignored_tap_indices`` excludes those taps
    from the candidate taps and echoes the actually ignored indices back; a
    valid anchor additionally carries ``offset_ms``, the anchor indices and,
    per pair, ``calibrated_tap_time_ms`` / ``calibrated_deviation_ms``; a
    valid ``tolerance_ms`` replaces the fixed 800 ms candidate window (in the
    raw pass and any recalibration alike) and is echoed back. Invalid ignored
    indices, anchors or tolerances are rejected with 400 and no result is
    produced, so the page can keep its current pairing on screen.
    """
    _revalidate_cues(request.cues)

    cues = [MatchCue(text=cue.text, time_ms=cue.time_ms) for cue in request.cues]
    taps = request.taps

    try:
        if not request.anchors:
            return match(
                cues,
                taps,
                ignored_tap_indices=request.ignored_tap_indices,
                tolerance_ms=request.tolerance_ms,
            )
        return match_with_anchor(
            cues,
            taps,
            request.anchors,
            ignored_tap_indices=request.ignored_tap_indices,
            tolerance_ms=request.tolerance_ms,
        )
    except ToleranceRejected as rejected:
        raise HTTPException(
            status_code=400,
            detail={
                "message": rejected.error.message,
                "code": rejected.error.code,
            },
        ) from rejected
    except IgnoredTapsRejected as rejected:
        raise HTTPException(
            status_code=400,
            detail={
                "message": rejected.error.message,
                "code": rejected.error.code,
            },
        ) from rejected
    except AnchorRejected as rejected:
        raise HTTPException(
            status_code=400,
            detail={
                "message": rejected.error.message,
                "code": rejected.error.code,
            },
        ) from rejected
