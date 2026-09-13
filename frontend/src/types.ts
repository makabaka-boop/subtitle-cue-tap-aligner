export const TOLERANCE_MS = 800;

export interface Cue {
  text: string;
  // bigint: adjacent large millisecond values must compare exactly; a JS
  // double would round 9007199254740993 to 9007199254740992 and falsely
  // report a duplicate. The API carries these as exact JSON integers.
  time_ms: bigint;
}

export type ParseErrorCode =
  | "EMPTY_DOCUMENT"
  | "EMPTY_LINE"
  | "MISSING_SEPARATOR"
  | "EMPTY_SUBTITLE"
  | "INVALID_TIME"
  | "NEGATIVE_TIME"
  | "NOT_STRICTLY_INCREASING"
  // Client-side only: never sent by the server.
  | "REHEARSAL_IN_PROGRESS";

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
  time_ms: bigint;
  seq: number;
}

export interface Anchor {
  cue_index: number;
  tap_index: number;
}

export type AnchorErrorCode =
  | "ANCHOR_INDEX_OUT_OF_RANGE"
  | "ANCHOR_DUPLICATED"
  | "ANCHOR_NOT_PAIRED";

export interface Pair {
  cue_index: number;
  cue_text: string;
  cue_time_ms: bigint;
  tap_index: number;
  tap_seq: number;
  tap_time_ms: bigint;
  deviation_ms: bigint;
  // Present only on calibrated (anchor) responses.
  calibrated_tap_time_ms?: bigint;
  calibrated_deviation_ms?: bigint;
}

export interface MatchResult {
  pairs: Pair[];
  unmatched_cue_indices: number[];
  unmatched_tap_indices: number[];
  // Present only when the result was produced with a calibration anchor.
  calibrated?: boolean;
  offset_ms?: bigint;
  anchor_cue_index?: number;
  anchor_tap_index?: number;
}
