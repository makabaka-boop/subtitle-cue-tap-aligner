"""Domain models shared by the parser, matcher and API layer."""
from __future__ import annotations

from enum import StrEnum


class ParseErrorCode(StrEnum):
    EMPTY_DOCUMENT = "EMPTY_DOCUMENT"
    EMPTY_LINE = "EMPTY_LINE"
    MISSING_SEPARATOR = "MISSING_SEPARATOR"
    EMPTY_SUBTITLE = "EMPTY_SUBTITLE"
    INVALID_TIME = "INVALID_TIME"
    NEGATIVE_TIME = "NEGATIVE_TIME"
    NOT_STRICTLY_INCREASING = "NOT_STRICTLY_INCREASING"


ERROR_MESSAGES: dict[ParseErrorCode, str] = {
    ParseErrorCode.EMPTY_DOCUMENT: "导入内容为空",
    ParseErrorCode.EMPTY_LINE: "空行：每行必须为“字幕文本|整数毫秒”",
    ParseErrorCode.MISSING_SEPARATOR: "缺少分隔符 |：每行必须为“字幕文本|整数毫秒”",
    ParseErrorCode.EMPTY_SUBTITLE: "字幕文本不得为空",
    ParseErrorCode.INVALID_TIME: "时间必须为整数毫秒",
    ParseErrorCode.NEGATIVE_TIME: "时间不得为负",
    ParseErrorCode.NOT_STRICTLY_INCREASING: "各行时间必须严格递增、不得重复",
}
