import { describe, expect, it } from "vitest";
import { decodeJSON, encodeJSON } from "./jsonBigint";

describe("encodeJSON", () => {
  it("emits bare integer literals for bigints, including unsafe values", () => {
    const raw = encodeJSON({ a: 5n, big: 9007199254740993n });
    expect(raw).toBe('{"a":5,"big":9007199254740993}');
  });

  it("keeps regular fields and nested structures intact", () => {
    const raw = encodeJSON({
      text: "甲",
      cues: [{ text: "A", time_ms: 100n }],
      seq: 2,
      ok: true,
      nil: null,
    });
    expect(JSON.parse(raw)).toEqual({
      text: "甲",
      cues: [{ text: "A", time_ms: 100 }],
      seq: 2,
      ok: true,
      nil: null,
    });
  });
});

describe("decodeJSON", () => {
  it("preserves unsafe integers as bigint", () => {
    const decoded = decodeJSON<{ a: bigint; b: bigint }>(
      '{"a":9007199254740993,"b":9007199254740994}',
    );
    expect(decoded.a).toBe(9007199254740993n);
    expect(decoded.b).toBe(9007199254740994n);
    expect(decoded.a === decoded.b).toBe(false);
  });

  it("leaves safe integers and floats as ordinary numbers", () => {
    const decoded = decodeJSON<{ seq: number; dev: number; text: string }>(
      '{"seq":3,"dev":-800,"text":"偏差"}',
    );
    expect(decoded.seq).toBe(3);
    expect(decoded.dev).toBe(-800);
    expect(typeof decoded.seq).toBe("number");
    expect(decoded.text).toBe("偏差");
  });

  it("does not touch digits appearing inside strings", () => {
    const decoded = decodeJSON<{ text: string }>(
      '{"text":"9007199254740993 and 9007199254740994"}',
    );
    expect(decoded.text).toBe("9007199254740993 and 9007199254740994");
  });

  it("round-trips a payload with unsafe times exactly", () => {
    const payload = {
      pairs: [
        {
          cue_index: 0,
          cue_text: "甲",
          cue_time_ms: 9007199254740993n,
          tap_index: 0,
          tap_seq: 0,
          tap_time_ms: 9007199254740999n,
          // Safe-range bigints encode to plain integers that decode as
          // numbers; the API layer normalizes known time fields to bigint.
          deviation_ms: 6,
        },
      ],
      unmatched_cue_indices: [],
      unmatched_tap_indices: [],
    };
    const decoded = decodeJSON<typeof payload>(encodeJSON(payload));
    expect(decoded.pairs[0].cue_time_ms).toBe(9007199254740993n);
    expect(decoded.pairs[0].tap_time_ms).toBe(9007199254740999n);
    expect(decoded.pairs[0].deviation_ms).toBe(6);
  });
});
