"""FastAPI application for the subtitle cue-point station."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .matcher import MatchCue, MatchResult, MatchTap, match
from .parser import ParseResponse, parse_schedule

app = FastAPI(title="字幕对点台 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ParseRequest(BaseModel):
    text: str


class MatchRequest(BaseModel):
    cues: list[MatchCue] = Field(default_factory=list)
    taps: list[MatchTap] = Field(default_factory=list)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/parse", response_model=ParseResponse)
def parse_endpoint(request: ParseRequest) -> ParseResponse:
    """Validate a schedule import; errors are located to concrete lines."""
    return parse_schedule(request.text)


@app.post("/api/match", response_model=MatchResult)
def match_endpoint(request: MatchRequest) -> MatchResult:
    """Re-validate cues server side, then pair them with the recorded taps."""
    if request.cues:
        schedule = "\n".join(
            f"{cue.text}|{cue.time_ms}" for cue in request.cues
        )
        parsed = parse_schedule(schedule)
        if not parsed.valid:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "计划时间表无效，未进行配对",
                    "errors": [error.model_dump() for error in parsed.errors],
                },
            )

    return match(
        [MatchCue(text=cue.text, time_ms=cue.time_ms) for cue in request.cues],
        request.taps,
    )
