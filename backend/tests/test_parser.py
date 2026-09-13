import pytest

from app.models import ParseErrorCode
from app.parser import parse_schedule


def codes_by_line(response):
    grouped: dict[int, set[ParseErrorCode]] = {}
    for error in response.errors:
        grouped.setdefault(error.line, set()).add(error.code)
    return grouped


def test_valid_schedule_parses_into_cues():
    response = parse_schedule("第一幕|0\n  主角登场 |1200\n谢幕| 2400 ")

    assert response.valid
    assert response.errors == []
    assert [(cue.text, cue.time_ms) for cue in response.cues] == [
        ("第一幕", 0),
        ("主角登场", 1200),
        ("谢幕", 2400),
    ]


def test_pipe_inside_subtitle_text_is_kept():
    response = parse_schedule("A|B|500")
    assert response.valid
    assert response.cues[0].text == "A|B"
    assert response.cues[0].time_ms == 500


def test_empty_document_is_rejected():
    response = parse_schedule("   \n\t\n  ")
    assert not response.valid
    assert codes_by_line(response)[1] == {ParseErrorCode.EMPTY_DOCUMENT}


def test_errors_are_located_to_lines():
    response = parse_schedule("开场|0\n坏行\n结尾|100")
    grouped = codes_by_line(response)
    assert not response.valid
    assert grouped[2] == {ParseErrorCode.MISSING_SEPARATOR}
    assert response.cues == []


def test_blank_line_is_locatable_error():
    response = parse_schedule("开场|0\n\n结尾|100")
    assert codes_by_line(response)[2] == {ParseErrorCode.EMPTY_LINE}


def test_empty_subtitle_is_rejected():
    for text in ("|100", "   |100"):
        response = parse_schedule(text)
        assert codes_by_line(response)[1] == {ParseErrorCode.EMPTY_SUBTITLE}


@pytest.mark.parametrize(
    "bad_time",
    ["abc", "1.5", "1e3", "1_000", "", "0x10", "一百", "500 |"],
)
def test_non_integer_times_are_rejected(bad_time):
    response = parse_schedule(f"字幕|{bad_time}")
    assert codes_by_line(response)[1] == {ParseErrorCode.INVALID_TIME}


def test_negative_time_is_rejected_with_dedicated_error():
    response = parse_schedule("字幕|-1")
    assert codes_by_line(response)[1] == {ParseErrorCode.NEGATIVE_TIME}


def test_plus_sign_integer_is_accepted():
    response = parse_schedule("字幕|+100")
    assert response.valid
    assert response.cues[0].time_ms == 100


def test_duplicate_and_non_increasing_times_are_located():
    response = parse_schedule("A|100\nB|100\nC|90\nD|300")
    grouped = codes_by_line(response)
    assert grouped[2] == {ParseErrorCode.NOT_STRICTLY_INCREASING}
    assert grouped[3] == {ParseErrorCode.NOT_STRICTLY_INCREASING}
    assert 4 not in grouped  # 300 > last *valid* parsed time (100)


def test_multiple_errors_on_one_line_are_all_reported():
    response = parse_schedule("|abc")
    assert {
        ParseErrorCode.EMPTY_SUBTITLE,
        ParseErrorCode.INVALID_TIME,
    } <= codes_by_line(response)[1]


def test_crlf_line_endings_are_supported():
    response = parse_schedule("A|0\r\nB|100\r\n")
    assert response.valid
    assert len(response.cues) == 2
