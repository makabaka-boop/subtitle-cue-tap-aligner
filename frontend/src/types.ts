export const TOLERANCE_MS = 800;

export interface Cue {
  text: string;
  time_ms: number;
}

export type ParseErrorCode =
  | "EMPTY_DOCUMENT"
  | "EMPTY_LINE"
  | "MISSING_SEPARATOR"
  | "EMPTY_SUBTITLE"
  | "INVALID_TIME"
  | "NEGATIVE_TIME"
  | "NOT_STRICTLY_INCREASING";

export interface LineError {
  line: number;
  code: ParseErrorCode;
  message: string;
}

export interface ParseResponse {
  valid: boolean;
  errors: LineError[];
  cues: Cue[];
}

export interface RecordedTap {
  time_ms: number;
  seq: number;
}

export interface Pair {
  cue_index: number;
  cue_text: string;
  cue_time_ms: number;
  tap_index: number;
  tap_seq: number;
  tap_time_ms: number;
  deviation_ms: number;
}

export interface MatchResult {
  pairs: Pair[];
  unmatched_cue_indices: number[];
  unmatched_tap_indices: number[];
}
