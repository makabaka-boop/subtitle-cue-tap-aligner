import { describe, expect, it } from "vitest";
import { formatSignedMs } from "./format";
import { parseSchedule } from "./parser";

describe("parseSchedule", () => {
  it("parses a valid schedule", () => {
    const result = parseSchedule("第一幕|0\n 主角登场 | 1200 ");
    expect(result.valid).toBe(true);
    expect(result.cues).toEqual([
      { text: "第一幕", time_ms: 0 },
      { text: "主角登场", time_ms: 1200 },
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
});

describe("formatSignedMs", () => {
  it("formats zero and positive values with an explicit plus sign", () => {
    expect(formatSignedMs(0)).toBe("+0 ms");
    expect(formatSignedMs(120)).toBe("+120 ms");
  });

  it("keeps the minus sign for negative values", () => {
    expect(formatSignedMs(-800)).toBe("-800 ms");
  });
});
