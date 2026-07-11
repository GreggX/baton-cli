// T014 — Deterministic token estimation fallback.
// Used when session data carries no exact usage accounting; readings produced from it
// MUST be labeled "estimated" (FR-013). No randomness, no time, no IO.

/**
 * Characters-per-token divisor for the estimation fallback.
 * Named constant so calibration (SC-007 accuracy test, T055) changes exactly one value.
 */
export const DIVISOR = 4;

/**
 * Estimate the token count of a piece of text: ceil(chars / DIVISOR).
 * Chars are UTF-16 code units (String.prototype.length) — deterministic for any input.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / DIVISOR);
}
