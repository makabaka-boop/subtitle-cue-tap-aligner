/** Signed deviation display, e.g. +120 ms / -800 ms / +0 ms. */
export function formatSignedMs(value: bigint): string {
  return `${value >= 0n ? "+" : ""}${value.toString()} ms`;
}
