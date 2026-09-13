/** Signed deviation display, e.g. +120 ms / -800 ms / +0 ms. */
export function formatSignedMs(value: number): string {
  return `${value >= 0 ? "+" : ""}${value} ms`;
}
