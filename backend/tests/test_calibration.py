import pytest

from app.matcher import (
    Anchor,
    AnchorRejected,
    MatchCue,
    MatchTap,
    TOLERANCE_MS,
    match,
    match_with_anchor,
)
from app.models import AnchorErrorCode


def cue(*spec):
    return [MatchCue(text=text, time_ms=time) for text, time in spec]


def tap(times):
    return [MatchTap(time_ms=time, seq=index) for index, time in enumerate(times)]


def pair_map(result):
    return {
        pair.cue_index: (pair.tap_index, pair.deviation_ms) for pair in result.pairs
    }


def test_fixed_global_delay_anchor_has_zero_calibrated_deviation():
    # 全场稳定起步偏移 +300 ms：每个原始偏差都是 +300。
    cues = cue(("A", 0), ("B", 1000), ("C", 2000))
    taps = tap([300, 1300, 2300])

    raw = match(cues, taps)
    assert [p.deviation_ms for p in raw.pairs] == [300, 300, 300]

    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.calibrated is True
    assert result.offset_ms == 300
    assert result.anchor_cue_index == 0
    assert result.anchor_tap_index == 0
    # 锚点校准后偏差严格为零……
    anchor_pair = next(p for p in result.pairs if p.cue_index == 0)
    assert anchor_pair.calibrated_deviation_ms == 0
    assert anchor_pair.calibrated_tap_time_ms == 0
    # ……其余行按既有规则重配，校准后偏差同样归零。
    assert sorted(pair_map(result).keys()) == [0, 1, 2]
    assert [p.calibrated_deviation_ms for p in result.pairs] == [0, 0, 0]
    assert [p.calibrated_tap_time_ms for p in result.pairs] == [0, 1000, 2000]
    # 原始时间与原始偏差仍逐行保留。
    assert [p.tap_time_ms for p in result.pairs] == [300, 1300, 2300]
    assert [p.deviation_ms for p in result.pairs] == [300, 300, 300]
    assert result.unmatched_cue_indices == []
    assert result.unmatched_tap_indices == []


def test_remaining_rows_are_repaired_by_the_existing_rule_with_jitter():
    # 固定延迟 250 ms 加上各自抖动；校准后仍落在 800 ms 窗内。
    cues = cue(("A", 0), ("B", 1000), ("C", 2000), ("D", 3000))
    taps = tap([250, 1310, 2180, 3250])  # +250, +310, +180, +250

    result = match_with_anchor(cues, taps, [Anchor(cue_index=1, tap_index=1)])
    assert result.offset_ms == 310
    calibrated = {p.cue_index: p.calibrated_deviation_ms for p in result.pairs}
    assert calibrated == {0: -60, 1: 0, 2: -130, 3: -60}
    # 锚点行锁定为原始配对。
    anchor_pair = result.pairs[1]
    assert anchor_pair.tap_index == 1
    assert anchor_pair.calibrated_tap_time_ms == 1000


def test_negative_offset_shifts_effective_times_forward():
    cues = cue(("A", 1000), ("B", 2000))
    taps = tap([800, 1800])  # 全场提前 200 ms
    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.offset_ms == -200
    assert [p.calibrated_deviation_ms for p in result.pairs] == [0, 0]
    assert [p.calibrated_tap_time_ms for p in result.pairs] == [1000, 2000]


def test_calibration_can_bring_an_out_of_range_tap_into_the_window():
    # 第二击原始距最近计划 900 ms（出窗、未配对）；以第一行做锚点应用
    # +100 ms 偏移（敲击整体减去 100）后，它恰好落在 800 ms 边界，按既有
    # 规则重新配上。
    cues = cue(("A", 0), ("B", 2000))
    taps = tap([100, 2900])
    raw = match(cues, taps)
    assert pair_map(raw) == {0: (0, 100)}
    assert raw.unmatched_tap_indices == [1]

    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.offset_ms == 100
    assert [p.cue_index for p in result.pairs] == [0, 1]
    second = result.pairs[1]
    assert second.tap_index == 1
    assert second.calibrated_tap_time_ms == 2800
    assert second.calibrated_deviation_ms == 800
    assert result.unmatched_tap_indices == []


def test_anchor_is_locked_and_cannot_be_stolen_by_an_earlier_tap():
    # cues@1000/1200；原始升序配对：1060->cue1(60)，1150->cue2(-50)。
    # 以第二行为锚点（偏移 -50）后，1060 的有效时间变为 1110，反而更靠近
    # cue2（90 < 110）——若不加锁就会抢走锚点行。
    cues = cue(("A", 1000), ("B", 1200))
    taps = tap([1060, 1150])
    raw = match(cues, taps)
    assert pair_map(raw) == {0: (0, 60), 1: (1, -50)}

    result = match_with_anchor(cues, taps, [Anchor(cue_index=1, tap_index=1)])
    assert result.offset_ms == -50
    # 锚点行保持原始配对且校准后偏差为零；其余行按既有规则配 cue1。
    assert pair_map(result) == {0: (0, 60), 1: (1, -50)}
    anchor_pair = result.pairs[1]
    assert anchor_pair.calibrated_tap_time_ms == 1200
    assert anchor_pair.calibrated_deviation_ms == 0
    assert result.pairs[0].calibrated_deviation_ms == 110


def test_reject_anchor_index_out_of_range():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([0, 1000])
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [Anchor(cue_index=5, tap_index=0)])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_INDEX_OUT_OF_RANGE
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=9)])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_INDEX_OUT_OF_RANGE


def test_reject_anchor_that_is_not_a_raw_pair():
    cues = cue(("A", 0), ("B", 5000))
    taps = tap([0, 100])  # tap1 未配对
    # 交叉组合（cue 与 tap 分别属于不同配对行）也不属于原始配对。
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=1)])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_NOT_PAIRED
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [Anchor(cue_index=1, tap_index=0)])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_NOT_PAIRED


def test_reject_duplicated_or_multiple_anchors():
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([0, 1000])
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_DUPLICATED
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(
            cues,
            taps,
            [Anchor(cue_index=0, tap_index=0), Anchor(cue_index=1, tap_index=1)],
        )
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_DUPLICATED
    # 同一锚点出现两次同样视为重复。
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(
            cues,
            taps,
            [Anchor(cue_index=0, tap_index=0), Anchor(cue_index=0, tap_index=0)],
        )
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_DUPLICATED


def test_reject_anchor_when_its_tap_was_unmatched():
    cues = cue(("A", 0))
    taps = tap([0, 5000])  # tap1 完全出窗
    with pytest.raises(AnchorRejected) as exc:
        match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=1)])
    assert exc.value.error.code is AnchorErrorCode.ANCHOR_NOT_PAIRED


def test_calibrated_offset_is_exact_with_huge_times():
    # 计划时间与敲击时间都远超 2**53，锚点原始偏差 150 ms（在 800 ms
    # 窗内）。偏移量与校准后时间都必须按 Python 任意精度整数精确计算，
    # 不被双精度舍入。
    base = 12_345_678_901_234_567_890
    cues = cue(("甲", base), ("乙", base + 2_000_000))
    taps = [
        MatchTap(time_ms=base + 150, seq=0),
        MatchTap(time_ms=base + 2_000_000 + 150, seq=1),
    ]
    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.offset_ms == 150
    anchor_pair = result.pairs[0]
    assert anchor_pair.calibrated_tap_time_ms == base
    assert anchor_pair.calibrated_deviation_ms == 0
    assert result.pairs[1].calibrated_tap_time_ms == base + 2_000_000
    assert result.pairs[1].calibrated_deviation_ms == 0

    # 整体延迟本身是超大整数时，校准后时间仍是精确减法。
    shift = 9_007_199_254_740_993 + 12_345
    cues3 = cue(("戊", shift), ("己", shift + 1_000_000))
    taps3 = [
        MatchTap(time_ms=shift - 800, seq=0),
        MatchTap(time_ms=shift + 1_000_000 - 800, seq=1),
    ]
    result3 = match_with_anchor(cues3, taps3, [Anchor(cue_index=0, tap_index=0)])
    assert result3.offset_ms == -800
    assert result3.pairs[0].calibrated_tap_time_ms == shift
    assert result3.pairs[0].calibrated_deviation_ms == 0
    assert result3.pairs[1].calibrated_deviation_ms == 0

    # 相邻超大整数仍可区分，0 偏移配对保持精确。
    edge = 9_007_199_254_740_993  # 2**53 + 1
    cues4 = cue(("庚", edge), ("辛", edge + 1))
    taps4 = [
        MatchTap(time_ms=edge + 1, seq=0),  # 精确命中 cue2
        MatchTap(time_ms=edge, seq=1),
    ]
    result4 = match_with_anchor(cues4, taps4, [Anchor(cue_index=1, tap_index=0)])
    assert result4.offset_ms == 0
    assert pair_map(result4) == {0: (1, 0), 1: (0, 0)}


def test_unmatched_entries_after_calibration_are_reported_in_order():
    cues = cue(("A", 0), ("B", 1000), ("C", 9000))
    taps = tap([100, 1100, 5000])  # 校准 -100：5000->4900 全部出窗
    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.offset_ms == 100
    assert {p.cue_index for p in result.pairs} == {0, 1}
    assert result.unmatched_cue_indices == [2]
    assert result.unmatched_tap_indices == [2]


def test_offset_keeps_all_repair_deviations_within_800_ms_rule():
    # 校准后仍超出 800 ms 的敲击按规则保持未配对。
    cues = cue(("A", 0), ("B", 1000))
    taps = tap([100, 2000])  # 校准 -100 后第二击 1900：距 cue2 900，出窗
    result = match_with_anchor(cues, taps, [Anchor(cue_index=0, tap_index=0)])
    assert result.offset_ms == 100
    assert [p.cue_index for p in result.pairs] == [0]
    assert result.pairs[0].calibrated_deviation_ms == 0
    assert result.unmatched_cue_indices == [1]
    assert result.unmatched_tap_indices == [1]
