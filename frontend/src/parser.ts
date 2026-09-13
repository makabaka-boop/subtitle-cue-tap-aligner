import type {
  Cue,
  LineError,
  ParseErrorCode,
  ParseResponse,
} from "./types";

// Client-side mirror of backend/app/parser.py: gives instant feedback and is
// covered by Vitest. The FastAPI /api/parse remains the authority — an import
// is only committed after the server accepts it.
const ERROR_MESSAGES: Record<ParseErrorCode, string> = {
  EMPTY_DOCUMENT: "导入内容为空",
  EMPTY_LINE: "空行：每行必须为“字幕文本|整数毫秒”",
  MISSING_SEPARATOR: "缺少分隔符 |：每行必须为“字幕文本|整数毫秒”",
  EMPTY_SUBTITLE: "字幕文本不得为空",
  INVALID_TIME: "时间必须为整数毫秒",
  NEGATIVE_TIME: "时间不得为负",
  NOT_STRICTLY_INCREASING: "各行时间必须严格递增、不得重复",
  REHEARSAL_IN_PROGRESS:
    "联排进行中：请先结束联排再重新导入计划，本次操作未改动已记录的敲击",
};

const INTEGER_RE = /^[+-]?\d+$/;

function lineError(line: number, code: ParseErrorCode): LineError {
  return { line, code, message: ERROR_MESSAGES[code] };
}

export function parseSchedule(raw: string): ParseResponse {
  const errors: LineError[] = [];
  const cues: Cue[] = [];

  if (raw.trim() === "") {
    return { valid: false, errors: [lineError(1, "EMPTY_DOCUMENT")], cues: [] };
  }

  let previousTime: bigint | null = null;

  raw.split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const lineNumber = i + 1;
    const line = rawLine.trim();

    if (line === "") {
      errors.push(lineError(lineNumber, "EMPTY_LINE"));
      return;
    }
    if (!line.includes("|")) {
      errors.push(lineError(lineNumber, "MISSING_SEPARATOR"));
      return;
    }

    const separator = line.lastIndexOf("|");
    const text = line.slice(0, separator).trim();
    const timeField = line.slice(separator + 1).trim();
    const lineErrors: LineError[] = [];

    if (text === "") {
      lineErrors.push(lineError(lineNumber, "EMPTY_SUBTITLE"));
    }

    let timeMs: bigint | null = null;
    if (!INTEGER_RE.test(timeField)) {
      lineErrors.push(lineError(lineNumber, "INVALID_TIME"));
    } else {
      const value = BigInt(timeField);
      if (value < 0n) {
        lineErrors.push(lineError(lineNumber, "NEGATIVE_TIME"));
      } else {
        timeMs = value;
      }
    }

    if (timeMs !== null) {
      if (previousTime !== null && timeMs <= previousTime) {
        lineErrors.push(lineError(lineNumber, "NOT_STRICTLY_INCREASING"));
      }
      previousTime = timeMs;
    }

    errors.push(...lineErrors);
    if (lineErrors.length === 0 && timeMs !== null) {
      cues.push({ text, time_ms: timeMs });
    }
  });

  if (errors.length > 0 || cues.length === 0) {
    return { valid: false, errors, cues: [] };
  }
  return { valid: true, errors: [], cues };
}
