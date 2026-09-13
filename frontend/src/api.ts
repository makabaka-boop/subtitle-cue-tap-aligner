import { decodeJSON, encodeJSON } from "./jsonBigint";
import type {
  Cue,
  MatchResult,
  ParseResponse,
  RecordedTap,
} from "./types";

export const API_BASE = "/api";

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
    })),
    unmatched_cue_indices: result.unmatched_cue_indices,
    unmatched_tap_indices: result.unmatched_tap_indices,
  };
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: encodeJSON(body),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = decodeJSON<{ detail?: unknown }>(await response.text());
      if (payload?.detail) {
        detail =
          typeof payload.detail === "string"
            ? payload.detail
            : JSON.stringify(payload.detail);
      }
    } catch {
      // keep the HTTP status message
    }
    throw new Error(detail);
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
): Promise<MatchResult> {
  const result = await postJSON<MatchResult>("/match", {
    cues: normalizeCues(cues),
    taps: normalizeTaps(taps),
  });
  return normalizeMatchResult(result);
}
