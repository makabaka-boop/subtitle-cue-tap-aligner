import { decodeJSON, encodeJSON } from "./jsonBigint";
import type {
  Anchor,
  Cue,
  MatchResult,
  ParseResponse,
  RecordedTap,
} from "./types";

export const API_BASE = "/api";

/** Server rejection carrying the user-facing reason (and anchor code, if any). */
export class ApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

// Unsafe-range integers arrive as bigint straight from the codec while
// safe-range ones are ordinary numbers; coerce the known integer time
// fields so the declared types always hold.
const asBigInt = (value: bigint | number): bigint => BigInt(value);

function normalizeCues(cues: Cue[]): Cue[] {
  return cues.map((cue) => ({ ...cue, time_ms: asBigInt(cue.time_ms) }));
}

function normalizeTaps(taps: RecordedTap[]): RecordedTap[] {
  return taps.map((tap) => ({ ...tap, time_ms: asBigInt(tap.time_ms) }));
}

function normalizeMatchResult(result: MatchResult): MatchResult {
  return {
    pairs: result.pairs.map((pair) => ({
      ...pair,
      cue_time_ms: asBigInt(pair.cue_time_ms),
      tap_time_ms: asBigInt(pair.tap_time_ms),
      deviation_ms: asBigInt(pair.deviation_ms),
      calibrated_tap_time_ms:
        pair.calibrated_tap_time_ms === undefined
          ? undefined
          : asBigInt(pair.calibrated_tap_time_ms),
      calibrated_deviation_ms:
        pair.calibrated_deviation_ms === undefined
          ? undefined
          : asBigInt(pair.calibrated_deviation_ms),
    })),
    unmatched_cue_indices: result.unmatched_cue_indices,
    unmatched_tap_indices: result.unmatched_tap_indices,
    calibrated: result.calibrated,
    offset_ms:
      result.offset_ms === undefined ? undefined : asBigInt(result.offset_ms),
    anchor_cue_index: result.anchor_cue_index,
    anchor_tap_index: result.anchor_tap_index,
  };
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: encodeJSON(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code: string | undefined;
    try {
      const payload = decodeJSON<{
        detail?: string | { message?: string; code?: string };
      }>(await response.text());
      if (payload?.detail) {
        if (typeof payload.detail === "string") {
          message = payload.detail;
        } else {
          if (payload.detail.message) {
            message = payload.detail.message;
          }
          code = payload.detail.code;
        }
      }
    } catch {
      // keep the HTTP status message
    }
    throw new ApiError(message, code);
  }
  return decodeJSON<T>(await response.text());
}

export async function parseOnServer(text: string): Promise<ParseResponse> {
  const result = await postJSON<ParseResponse>("/parse", { text });
  return { ...result, cues: normalizeCues(result.cues) };
}

export async function pairOnServer(
  cues: Cue[],
  taps: RecordedTap[],
  anchors?: Anchor[],
): Promise<MatchResult> {
  const result = await postJSON<MatchResult>("/match", {
    cues: normalizeCues(cues),
    taps: normalizeTaps(taps),
    // Omit the field entirely for legacy requests so traffic without an
    // anchor is byte-for-byte identical to the original API on the wire.
    ...(anchors ? { anchors } : {}),
  });
  return normalizeMatchResult(result);
}
