"""Cue/tap pairing.

The service processes taps in ascending time order. For each tap it looks
at every cue not used yet and:

* only considers cues whose absolute deviation from the tap is at most
  ``TOLERANCE_MS`` (800 ms);
* picks the cue with the smallest absolute deviation;
* on a tie, picks the cue with the earlier cue time.

Each cue and each tap is used at most once. Nothing outside this rule is
introduced: there is no second threshold and no pass/fail classification.

Calibration
-----------

When the whole run carries a stable start offset, the operator may pick one
already-paired row as the calibration anchor. The offset is the anchor's raw
deviation (tap - cue); applying it to every tap and re-running the exact same
greedy rule yields the calibrated result. The anchor pair is locked before
the second pairing pass, so every other tap is resolved by the ordinary
ascending-order / single-use / 800 ms / minimum-deviation rule.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from .models import AnchorErrorCode

TOLERANCE_MS = 800


class MatchCue(BaseModel):
    text: str
    time_ms: int = Field(ge=0)


class MatchTap(BaseModel):
    """A keystroke; ``seq`` preserves the browser submission order."""

    time_ms: int = Field(ge=0)
    seq: int = Field(ge=0)


class Anchor(BaseModel):
    """One paired row (cue index + tap index) chosen as the anchor."""

    cue_index: int = Field(ge=0)
    tap_index: int = Field(ge=0)


class Pair(BaseModel):
    cue_index: int = Field(ge=0)
    cue_text: str
    cue_time_ms: int = Field(ge=0)
    tap_index: int = Field(ge=0)
    tap_seq: int = Field(ge=0)
    tap_time_ms: int = Field(ge=0)
    deviation_ms: int


class CalibratedPair(Pair):
    """A pair after applying the global offset; may be a different pairing
    than the raw one, so ``tap_index``/``tap_seq`` can differ too."""

    calibrated_tap_time_ms: int
    calibrated_deviation_ms: int


class MatchResult(BaseModel):
    pairs: list[Pair] = Field(default_factory=list)
    unmatched_cue_indices: list[int] = Field(default_factory=list)
    unmatched_tap_indices: list[int] = Field(default_factory=list)


class CalibratedMatchResult(MatchResult):
    calibrated: bool = True
    offset_ms: int = 0
    anchor_cue_index: int = Field(ge=0)
    anchor_tap_index: int = Field(ge=0)
    # Each pair carries calibrated_tap_time_ms / calibrated_deviation_ms.
    pairs: list[CalibratedPair] = Field(default_factory=list)


class AnchorError(BaseModel):
    code: AnchorErrorCode
    message: str


class AnchorRejected(Exception):
    """Raised when an anchor cannot calibrate the run."""

    def __init__(self, code: AnchorErrorCode) -> None:
        from .models import ANCHOR_ERROR_MESSAGES

        self.error = AnchorError(code=code, message=ANCHOR_ERROR_MESSAGES[code])
        super().__init__(self.error.message)


def _ordered_indices(taps: list[MatchTap]) -> list[int]:
    """Tap indices in ascending time; submission order (seq) breaks ties."""
    return [
        tap_index
        for tap_index, _ in sorted(
            enumerate(taps), key=lambda item: (item[1].time_ms, item[1].seq, item[0])
        )
    ]


def _greedy_pairs(
    cues: list[MatchCue],
    taps: list[MatchTap],
    *,
    offsets_by_tap: dict[int, int] | None = None,
    locked: dict[int, int] | None = None,
) -> tuple[dict[int, int], set[int]]:
    """Run the greedy rule against *effective* tap times.

    ``offsets_by_tap`` maps a tap index to the amount added to its raw time
    (all taps share the same calibration offset in practice, but keeping it
    per tap leaves the routine generic). ``locked`` pre-claims tap->cue pairs
    that never compete and can never be stolen.

    Returns the chosen ``{tap_index: cue_index}`` mapping and the set of used
    cue indices. Taps are processed in raw-time ascending order; a constant
    offset preserves that order.
    """
    offsets_by_tap = offsets_by_tap or {}
    locked = locked or {}

    used_cues: set[int] = set(locked.values())
    chosen: dict[int, int] = {}

    for tap_index in _ordered_indices(taps):
        if tap_index in locked:
            chosen[tap_index] = locked[tap_index]
            continue
        tap = taps[tap_index]
        effective_time = tap.time_ms + offsets_by_tap.get(tap_index, 0)

        candidates: list[tuple[int, int, int]] = []  # (abs_delta, cue_time, index)
        for cue_index, cue in enumerate(cues):
            if cue_index in used_cues:
                continue
            deviation = effective_time - cue.time_ms
            if abs(deviation) <= TOLERANCE_MS:
                candidates.append((abs(deviation), cue.time_ms, cue_index))

        if not candidates:
            continue

        # Minimum absolute deviation, then earlier cue time. Equal cue times
        # never occur (parser forbids duplicates); index is a final safeguard.
        _, _, cue_index = min(candidates)
        used_cues.add(cue_index)
        chosen[tap_index] = cue_index

    return chosen, used_cues


def _build_result(
    cues: list[MatchCue],
    taps: list[MatchTap],
    chosen: dict[int, int],
    used_cues: set[int],
) -> MatchResult:
    pairs: list[Pair] = []
    for tap_index, cue_index in chosen.items():
        cue = cues[cue_index]
        tap = taps[tap_index]
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

    used_taps = set(chosen)
    return MatchResult(
        pairs=pairs,
        unmatched_cue_indices=[
            index for index in range(len(cues)) if index not in used_cues
        ],
        unmatched_tap_indices=[
            index for index in _ordered_indices(taps) if index not in used_taps
        ],
    )


def match(cues: list[MatchCue], taps: list[MatchTap]) -> MatchResult:
    chosen, used_cues = _greedy_pairs(cues, taps)
    return _build_result(cues, taps, chosen, used_cues)


def match_with_anchor(
    cues: list[MatchCue],
    taps: list[MatchTap],
    anchors: list[Anchor],
) -> CalibratedMatchResult:
    """Calibrate the whole run with one anchor row, then re-pair.

    The anchors are validated in order: within range, unique, and present in
    the raw pairing. Any rejection leaves the caller's current result intact
    (the API surfaces it as a 400 and the page keeps what it already shows).
    """
    # 1. At most one anchor per calibration, and no index repeated.
    if len(anchors) != 1 or any(
        entry.cue_index == other.cue_index or entry.tap_index == other.tap_index
        for i, entry in enumerate(anchors)
        for other in anchors[i + 1 :]
    ):
        raise AnchorRejected(AnchorErrorCode.ANCHOR_DUPLICATED)
    anchor = anchors[0]

    # 2. Both indices must name an existing cue/tap.
    if not (0 <= anchor.cue_index < len(cues)) or not (
        0 <= anchor.tap_index < len(taps)
    ):
        raise AnchorRejected(AnchorErrorCode.ANCHOR_INDEX_OUT_OF_RANGE)

    # 3. The anchor must be one of the raw (uncalibrated) pairs.
    raw_chosen, _ = _greedy_pairs(cues, taps)
    if raw_chosen.get(anchor.tap_index) != anchor.cue_index:
        raise AnchorRejected(AnchorErrorCode.ANCHOR_NOT_PAIRED)

    # offset = raw deviation of the anchor; calibrated anchor deviation is 0.
    offset_ms = taps[anchor.tap_index].time_ms - cues[anchor.cue_index].time_ms
    offsets = {tap_index: -offset_ms for tap_index in range(len(taps))}

    # Lock the anchor so the remaining rows are resolved purely by the rule.
    chosen, used_cues = _greedy_pairs(
        cues,
        taps,
        offsets_by_tap=offsets,
        locked={anchor.tap_index: anchor.cue_index},
    )

    pairs: list[CalibratedPair] = []
    for tap_index, cue_index in chosen.items():
        cue = cues[cue_index]
        tap = taps[tap_index]
        calibrated_time = tap.time_ms - offset_ms
        pairs.append(
            CalibratedPair(
                cue_index=cue_index,
                cue_text=cue.text,
                cue_time_ms=cue.time_ms,
                tap_index=tap_index,
                tap_seq=tap.seq,
                tap_time_ms=tap.time_ms,
                deviation_ms=tap.time_ms - cue.time_ms,
                calibrated_tap_time_ms=calibrated_time,
                calibrated_deviation_ms=calibrated_time - cue.time_ms,
            )
        )
    pairs.sort(key=lambda pair: pair.cue_index)

    used_taps = set(chosen)
    return CalibratedMatchResult(
        pairs=pairs,
        unmatched_cue_indices=[
            index for index in range(len(cues)) if index not in used_cues
        ],
        unmatched_tap_indices=[
            index for index in _ordered_indices(taps) if index not in used_taps
        ],
        offset_ms=offset_ms,
        anchor_cue_index=anchor.cue_index,
        anchor_tap_index=anchor.tap_index,
    )
