"""FastAPI application for the subtitle cue-point station."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .matcher import (
    Anchor,
    AnchorRejected,
    MatchCue,
    MatchResult,
    MatchTap,
    match,
    match_with_anchor,
)
from .parser import ParseResponse, parse_schedule

app = FastAPI(title="字幕对点台 API", version="1.1.0")

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
    """Pair cues with taps, optionally calibrating the run on one anchor row.

    Without an anchor the response is exactly the legacy result. With a
    valid anchor it additionally carries ``offset_ms``, the anchor indices
    and, per pair, ``calibrated_tap_time_ms`` / ``calibrated_deviation_ms``.
    Invalid anchors are rejected with 400 and no result is produced, so the
    page can keep its current pairing on screen.
    """
    _revalidate_cues(request.cues)

    cues = [MatchCue(text=cue.text, time_ms=cue.time_ms) for cue in request.cues]
    taps = request.taps

    if not request.anchors:
        return match(cues, taps)

    try:
        return match_with_anchor(cues, taps, request.anchors)
    except AnchorRejected as rejected:
        raise HTTPException(
            status_code=400,
            detail={
                "message": rejected.error.message,
                "code": rejected.error.code,
            },
        ) from rejected
