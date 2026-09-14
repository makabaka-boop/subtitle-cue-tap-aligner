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


class AnchorErrorCode(StrEnum):
    """Why a calibration anchor request was rejected."""

    ANCHOR_INDEX_OUT_OF_RANGE = "ANCHOR_INDEX_OUT_OF_RANGE"
    ANCHOR_DUPLICATED = "ANCHOR_DUPLICATED"
    ANCHOR_NOT_PAIRED = "ANCHOR_NOT_PAIRED"


ANCHOR_ERROR_MESSAGES: dict[AnchorErrorCode, str] = {
    AnchorErrorCode.ANCHOR_INDEX_OUT_OF_RANGE: "锚点超出当前计划或敲击范围，未重新对点",
    AnchorErrorCode.ANCHOR_DUPLICATED: "锚点重复：每次校准只能选择一个唯一配对行，未重新对点",
    AnchorErrorCode.ANCHOR_NOT_PAIRED: "锚点不属于原始配对结果，未重新对点",
}


class IgnoredTapErrorCode(StrEnum):
    """Why a set of ignored tap indices was rejected."""

    IGNORED_TAP_INDEX_OUT_OF_RANGE = "IGNORED_TAP_INDEX_OUT_OF_RANGE"
    IGNORED_TAP_INDEX_DUPLICATED = "IGNORED_TAP_INDEX_DUPLICATED"


IGNORED_TAP_ERROR_MESSAGES: dict[IgnoredTapErrorCode, str] = {
    IgnoredTapErrorCode.IGNORED_TAP_INDEX_OUT_OF_RANGE: "忽略下标超出本场敲击范围，未进行配对",
    IgnoredTapErrorCode.IGNORED_TAP_INDEX_DUPLICATED: "忽略下标重复：每个敲击下标至多出现一次，未进行配对",
}
