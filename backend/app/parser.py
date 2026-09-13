"""Schedule text parser.

Input format: one cue per line, ``subtitle text|integer milliseconds``.

Rules enforced here:
* subtitle text must not be empty;
* the time must be an integer and must not be negative;
* cue times must be strictly increasing (duplicates rejected).

Every error is located at its 1-based line number; several errors may be
reported for the same line. Whitespace-only documents are rejected.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field

from .models import ERROR_MESSAGES, ParseErrorCode

_INTEGER_RE = re.compile(r"^[+-]?\d+$")


class Cue(BaseModel):
    text: str
    time_ms: int = Field(ge=0)


class LineError(BaseModel):
    line: int = Field(ge=1)
    code: ParseErrorCode
    message: str


class ParseResponse(BaseModel):
    valid: bool
    errors: list[LineError] = Field(default_factory=list)
    cues: list[Cue] = Field(default_factory=list)


def _line_error(line: int, code: ParseErrorCode) -> LineError:
    return LineError(line=line, code=code, message=ERROR_MESSAGES[code])


def parse_schedule(raw: str) -> ParseResponse:
    """Parse the raw schedule text and return either cues or located errors."""
    errors: list[LineError] = []
    parsed: list[tuple[int, Cue]] = []

    if raw is None or raw.strip() == "":
        return ParseResponse(
            valid=False,
            errors=[_line_error(1, ParseErrorCode.EMPTY_DOCUMENT)],
        )

    lines = raw.splitlines()
    previous_time: int | None = None
    previous_line: int | None = None

    for index, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if line == "":
            errors.append(_line_error(index, ParseErrorCode.EMPTY_LINE))
            continue

        if "|" not in line:
            errors.append(_line_error(index, ParseErrorCode.MISSING_SEPARATOR))
            continue

        text, _, time_field = line.rpartition("|")
        text = text.strip()
        time_field = time_field.strip()

        line_errors: list[LineError] = []
        if text == "":
            line_errors.append(_line_error(index, ParseErrorCode.EMPTY_SUBTITLE))

        time_ms: int | None = None
        if not _INTEGER_RE.match(time_field):
            line_errors.append(_line_error(index, ParseErrorCode.INVALID_TIME))
        else:
            value = int(time_field)
            if value < 0:
                line_errors.append(_line_error(index, ParseErrorCode.NEGATIVE_TIME))
            else:
                time_ms = value

        if time_ms is not None:
            if previous_time is not None and time_ms <= previous_time:
                order_error = _line_error(
                    index, ParseErrorCode.NOT_STRICTLY_INCREASING
                )
                assert previous_line is not None
                line_errors.append(order_error)
            previous_time = time_ms
            previous_line = index

        errors.extend(line_errors)
        if not line_errors and time_ms is not None:
            parsed.append((index, Cue(text=text, time_ms=time_ms)))

    if errors:
        return ParseResponse(valid=False, errors=errors)

    cues = [cue for _, cue in parsed]
    if not cues:
        return ParseResponse(
            valid=False,
            errors=[_line_error(1, ParseErrorCode.EMPTY_DOCUMENT)],
        )
    return ParseResponse(valid=True, cues=cues)
