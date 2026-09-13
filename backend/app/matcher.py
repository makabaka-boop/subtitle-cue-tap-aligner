"""Cue/tap pairing.

The service processes taps in ascending time order. For each tap it looks
at every cue not used yet and:

* only considers cues whose absolute deviation from the tap is at most
  ``TOLERANCE_MS`` (800 ms);
* picks the cue with the smallest absolute deviation;
* on a tie, picks the cue with the earlier cue time.

Each cue and each tap is used at most once. Nothing outside this rule is
introduced: there is no second threshold and no pass/fail classification.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from .models import ParseErrorCode

TOLERANCE_MS = 800


class MatchCue(BaseModel):
    text: str
    time_ms: int = Field(ge=0)


class MatchTap(BaseModel):
    """A keystroke; ``seq`` preserves the browser submission order."""

    time_ms: int = Field(ge=0)
    seq: int = Field(ge=0)


class Pair(BaseModel):
    cue_index: int = Field(ge=0)
    cue_text: str
    cue_time_ms: int = Field(ge=0)
    tap_index: int = Field(ge=0)
    tap_seq: int = Field(ge=0)
    tap_time_ms: int = Field(ge=0)
    deviation_ms: int


class MatchResult(BaseModel):
    pairs: list[Pair] = Field(default_factory=list)
    unmatched_cue_indices: list[int] = Field(default_factory=list)
    unmatched_tap_indices: list[int] = Field(default_factory=list)


class ScheduleInvalid(BaseModel):
    code: ParseErrorCode
    line: int
    message: str


def match(cues: list[MatchCue], taps: list[MatchTap]) -> MatchResult:
    # Taps in ascending time; submission order (seq) breaks equal times.
    ordered_taps = sorted(
        enumerate(taps), key=lambda item: (item[1].time_ms, item[1].seq, item[0])
    )

    used_cues: set[int] = set()
    pairs: list[Pair] = []

    for tap_index, tap in ordered_taps:
        candidates: list[tuple[int, int, int]] = []  # (abs_delta, cue_time, index)
        for cue_index, cue in enumerate(cues):
            if cue_index in used_cues:
                continue
            deviation = tap.time_ms - cue.time_ms
            if abs(deviation) <= TOLERANCE_MS:
                candidates.append((abs(deviation), cue.time_ms, cue_index))

        if not candidates:
            continue

        # Minimum absolute deviation, then earlier cue time. Equal cue times
        # never occur (parser forbids duplicates); index is a final safeguard.
        _, _, cue_index = min(candidates)
        cue = cues[cue_index]
        used_cues.add(cue_index)
        pairs.append(
            Pair(
                cue_index=cue_index,
                cue_text=cue.text,
                cue_time_ms=cue.time_ms,
                tap_index=tap_index,
                tap_seq=tap.seq,
                tap_time_ms=tap.time_ms,
                deviation_ms=tap.time_ms - cue.time_ms,
            )
        )

    # The page connects pairs line by line in script (cue) order.
    pairs.sort(key=lambda pair: pair.cue_index)

    return MatchResult(
        pairs=pairs,
        unmatched_cue_indices=[
            index for index in range(len(cues)) if index not in used_cues
        ],
        unmatched_tap_indices=[
            index
            for index, _ in sorted(
                enumerate(taps),
                key=lambda item: (item[1].time_ms, item[1].seq, item[0]),
            )
            if index not in {pair.tap_index for pair in pairs}
        ],
    )
