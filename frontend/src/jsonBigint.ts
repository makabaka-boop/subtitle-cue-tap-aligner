/**
 * Exact-integer JSON transport.
 *
 * Cue/tap times are millisecond integers and must survive the browser's
 * double-based JSON.parse untouched (two adjacent values above
 * Number.MAX_SAFE_INTEGER otherwise collapse to the same double). Python
 * handles arbitrary-size integers natively.
 *
 * Encoding: bigints are written to JSON as tagged strings, then the tags are
 * removed so the wire payload still contains bare integer literals.
 * Decoding: bare integers that would not round-trip through a double are
 * quoted as tagged strings before native parsing, and revived to bigint;
 * tagged bigints (e.g. produced by our own encoder) always revive as
 * bigint, even small ones, preserving their declared type.
 */

const TAG = "__cueStationBigintTag__";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** JSON.stringify replacer: bigint -> tagged string. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${TAG}${value.toString()}` : value;
}

/** JSON.parse reviver: tagged string -> bigint. */
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(TAG)) {
    return BigInt(value.slice(TAG.length));
  }
  return value;
}

/**
 * Quote integer literals that would not round-trip through a double as
 * tagged strings before the native parser rounds them, skipping string
 * contents (where escapes may appear). Safe-range integers stay numbers.
 */
function tagUnsafeIntegerLiterals(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += raw.slice(start, i);
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      i += 1;
      while (i < raw.length && raw[i] >= "0" && raw[i] <= "9") {
        i += 1;
      }
      const token = raw.slice(start, i);
      const isInteger = raw[i] !== "." && raw[i] !== "e" && raw[i] !== "E";
      if (isInteger) {
        const magnitude = BigInt(token[0] === "-" ? token.slice(1) : token);
        if (magnitude > MAX_SAFE) {
          out += `"${TAG}${token}"`;
          continue;
        }
      }
      out += token;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Tagged bigints end up as quoted `"TAG123"`; turn them back into literals. */
function stripQuotedTags(json: string): string {
  return json.replace(
    new RegExp(`"${TAG}(-?\\d+)"`, "g"),
    (_match, digits: string) => digits,
  );
}

export function encodeJSON(value: unknown): string {
  return stripQuotedTags(JSON.stringify(value, bigintReplacer));
}

export function decodeJSON<T>(raw: string): T {
  return JSON.parse(tagUnsafeIntegerLiterals(raw), bigintReviver) as T;
}
