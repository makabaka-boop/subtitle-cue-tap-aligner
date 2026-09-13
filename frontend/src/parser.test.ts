import { describe, expect, it } from "vitest";
import { formatSignedMs } from "./format";
import { parseSchedule } from "./parser";

describe("parseSchedule", () => {
  it("parses a valid schedule", () => {
    const result = parseSchedule("第一幕|0\n 主角登场 | 1200 ");
    expect(result.valid).toBe(true);
    expect(result.cues).toEqual([
      { text: "第一幕", time_ms: 0n },
      { text: "主角登场", time_ms: 1200n },
    ]);
  });

  it("rejects empty input", () => {
    const result = parseSchedule("  \n\t\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0].line).toBe(1);
    expect(result.errors[0].code).toBe("EMPTY_DOCUMENT");
  });

  it("locates errors to specific lines without dropping later checks", () => {
    const result = parseSchedule("A|0\n坏行\n|-5\nB|0\nC|3");
    expect(result.valid).toBe(false);
    const byLine = new Map(result.errors.map((e) => [e.line, e.code]));
    expect(byLine.get(2)).toBe("MISSING_SEPARATOR");
    expect(byLine.get(3)).toMatch(/EMPTY_SUBTITLE|NEGATIVE_TIME/);
    expect(byLine.get(4)).toBe("NOT_STRICTLY_INCREASING");
    expect(result.cues).toEqual([]);
  });

  it.each([["abc"], ["1.5"], ["1e3"], ["1_000"], [""]])(
    "rejects non-integer time %j",
    (bad) => {
      const result = parseSchedule(`字幕|${bad}`);
      expect(result.errors.map((e) => e.code)).toContain("INVALID_TIME");
    },
  );

  it("keeps pipes that are part of the subtitle text", () => {
    const result = parseSchedule("A|B|500");
    expect(result.valid).toBe(true);
    expect(result.cues[0].text).toBe("A|B");
  });

  it("never returns cues when the document is invalid", () => {
    const result = parseSchedule("A|0\nB|0");
    expect(result.valid).toBe(false);
    expect(result.cues).toEqual([]);
  });

  it("accepts adjacent large integers as strictly increasing", () => {
    // These two values are indistinguishable in double precision; only
    // exact (bigint) comparison sees them as distinct and increasing.
    const a = "9007199254740993"; // 2^53 + 1
    const b = "9007199254740994"; // 2^53 + 2
    const result = parseSchedule(`甲|${a}\n乙|${b}`);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.cues[0].time_ms).toBe(BigInt(a));
    expect(result.cues[1].time_ms).toBe(BigInt(b));
  });

  it("still rejects true duplicates beyond double-safe range", () => {
    const big = "9007199254740993";
    const result = parseSchedule(`甲|${big}\n乙|${big}`);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("NOT_STRICTLY_INCREASING");
    expect(result.errors[0].line).toBe(2);
  });
});

describe("formatSignedMs", () => {
  it("formats zero and positive values with an explicit plus sign", () => {
    expect(formatSignedMs(0n)).toBe("+0 ms");
    expect(formatSignedMs(120n)).toBe("+120 ms");
  });

  it("keeps the minus sign for negative values", () => {
    expect(formatSignedMs(-800n)).toBe("-800 ms");
  });

  it("prints large values without exponential notation", () => {
    expect(formatSignedMs(9007199254740993n)).toBe("+9007199254740993 ms");
  });
});
