import { afterEach, describe, expect, it, vi } from "vitest";
import { pairOnServer } from "./api";
import type { Cue, RecordedTap } from "./types";

const CUES: Cue[] = [
  { text: "开场", time_ms: 0n },
  { text: "谢幕", time_ms: 1000n },
];
const TAPS: RecordedTap[] = [
  { time_ms: 0n, seq: 0 },
  { time_ms: 700n, seq: 1 },
  { time_ms: 1000n, seq: 2 },
];

const LEGACY_RESPONSE = {
  pairs: [
    {
      cue_index: 0,
      cue_text: "开场",
      cue_time_ms: 0,
      tap_index: 0,
      tap_seq: 0,
      tap_time_ms: 0,
      deviation_ms: 0,
    },
  ],
  unmatched_cue_indices: [1],
  unmatched_tap_indices: [1, 2],
};

function stubFetch(payload: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pairOnServer ignored taps", () => {
  it("omits ignored_tap_indices when nothing is ignored", async () => {
    for (const ignored of [undefined, []]) {
      const calls = stubFetch(LEGACY_RESPONSE);
      const result = await pairOnServer(CUES, TAPS, undefined, ignored);
      expect(Object.keys(calls[0].body).sort()).toEqual(["cues", "taps"]);
      expect(result.ignored_tap_indices).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });

  it("sends ignored_tap_indices and normalizes them from the response", async () => {
    const calls = stubFetch({
      ...LEGACY_RESPONSE,
      unmatched_tap_indices: [],
      ignored_tap_indices: [1],
    });
    const result = await pairOnServer(CUES, TAPS, undefined, [1]);
    expect(calls[0].body.ignored_tap_indices).toEqual([1]);
    expect(calls[0].body.anchors).toBeUndefined();
    expect(result.ignored_tap_indices).toEqual([1]);
    expect(result.unmatched_tap_indices).toEqual([]);
  });

  it("carries the same ignored indices together with an anchor", async () => {
    const calls = stubFetch({
      ...LEGACY_RESPONSE,
      ignored_tap_indices: [1],
      calibrated: true,
      offset_ms: 0,
      anchor_cue_index: 0,
      anchor_tap_index: 0,
    });
    const result = await pairOnServer(
      CUES,
      TAPS,
      [{ cue_index: 0, tap_index: 0 }],
      [1],
    );
    expect(calls[0].body.anchors).toEqual([{ cue_index: 0, tap_index: 0 }]);
    expect(calls[0].body.ignored_tap_indices).toEqual([1]);
    expect(result.ignored_tap_indices).toEqual([1]);
    expect(result.calibrated).toBe(true);
  });
});

describe("pairOnServer tolerance", () => {
  it("omits tolerance_ms when no tolerance is given", async () => {
    const calls = stubFetch(LEGACY_RESPONSE);
    const result = await pairOnServer(CUES, TAPS, undefined, undefined);
    expect(Object.keys(calls[0].body).sort()).toEqual(["cues", "taps"]);
    expect(result.tolerance_ms).toBeUndefined();
  });

  it("sends tolerance_ms and normalizes the echoed value", async () => {
    const calls = stubFetch({ ...LEGACY_RESPONSE, tolerance_ms: 1000 });
    const result = await pairOnServer(CUES, TAPS, undefined, undefined, 1000);
    expect(calls[0].body.tolerance_ms).toBe(1000);
    expect(result.tolerance_ms).toBe(1000);
  });

  it("sends an unparseable entry as-is so the server can explain", async () => {
    const calls = stubFetch(LEGACY_RESPONSE);
    await pairOnServer(CUES, TAPS, undefined, undefined, "abc");
    expect(calls[0].body.tolerance_ms).toBe("abc");
  });

  it("carries the same tolerance together with an anchor and ignored taps", async () => {
    const calls = stubFetch({
      ...LEGACY_RESPONSE,
      ignored_tap_indices: [1],
      tolerance_ms: 1000,
      calibrated: true,
      offset_ms: 0,
      anchor_cue_index: 0,
      anchor_tap_index: 0,
    });
    const result = await pairOnServer(
      CUES,
      TAPS,
      [{ cue_index: 0, tap_index: 0 }],
      [1],
      1000,
    );
    expect(calls[0].body.anchors).toEqual([{ cue_index: 0, tap_index: 0 }]);
    expect(calls[0].body.ignored_tap_indices).toEqual([1]);
    expect(calls[0].body.tolerance_ms).toBe(1000);
    expect(result.tolerance_ms).toBe(1000);
    expect(result.calibrated).toBe(true);
  });
});
