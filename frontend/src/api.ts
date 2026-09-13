import type { Cue, MatchResult, ParseResponse, RecordedTap } from "./types";

const API_BASE = "/api";

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
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
  return (await response.json()) as T;
}

export function parseOnServer(text: string): Promise<ParseResponse> {
  return postJSON<ParseResponse>("/parse", { text });
}

export function pairOnServer(
  cues: Cue[],
  taps: RecordedTap[],
): Promise<MatchResult> {
  return postJSON<MatchResult>("/match", { cues, taps });
}
