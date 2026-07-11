// T009 — chars/4 token estimation: determinism and edge cases (empty, unicode).
import { describe, expect, it } from 'vitest';
import { DIVISOR, estimateTokens } from '../../src/lib/estimate.js';

describe('estimateTokens', () => {
  it('uses a named divisor constant defaulting to 4', () => {
    expect(DIVISOR).toBe(4);
  });

  it('empty text estimates 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up partial tokens (ceil)', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('scales as ceil(chars / 4)', () => {
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('is deterministic: identical input always yields the identical estimate', () => {
    const text = 'We decided to use the adapter approach for the session source.';
    const first = estimateTokens(text);
    for (let i = 0; i < 100; i += 1) {
      expect(estimateTokens(text)).toBe(first);
    }
  });

  it('counts unicode input by UTF-16 code units, deterministically', () => {
    // Latin-1 accented char: 5 code units -> ceil(5/4) = 2
    expect(estimateTokens('héllo')).toBe(2);
    // CJK: 4 code units -> 1
    expect(estimateTokens('你好世界')).toBe(1);
    // Emoji surrogate pair: 2 code units -> 1
    expect(estimateTokens('\u{1f600}')).toBe(1);
    // 10 emoji = 20 code units -> 5
    expect(estimateTokens('\u{1f600}'.repeat(10))).toBe(5);
  });

  it('never returns a negative or fractional count', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', '\u{1f600}x']) {
      const estimate = estimateTokens(text);
      expect(estimate).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(estimate)).toBe(true);
    }
  });
});
