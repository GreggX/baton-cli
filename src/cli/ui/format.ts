// Canonical UI strings, glyphs, and format formulas from design-notes.md
// ("Design tokens" + "Canonical strings & formulas") — the single place the CLI
// and Ink views take their copy from. Pure functions only: no clock, no IO.
import { turnsToRed } from '../../core/monitor/reader.js';
import type { ZoneName } from '../../core/monitor/types.js';

// ── Design tokens (Tokyo Night) ───────────────────────────────────────────────

/** Zone glyphs — shape is the primary channel (colorblind-safe). */
export const ZONE_GLYPHS: Readonly<Record<ZoneName, string>> = Object.freeze({
  green: '●',
  yellow: '◆',
  orange: '▲',
  red: '■',
});

/** Truecolor zone colors. */
export const ZONE_COLORS: Readonly<Record<ZoneName, string>> = Object.freeze({
  green: '#9ece6a',
  yellow: '#e0af68',
  orange: '#ff9e64',
  red: '#f7768e',
});

export const UNKNOWN_GLYPH = '◌';
export const UNKNOWN_COLOR = '#565f89';
export const TEXT_COLOR = '#c0caf5';
export const MUTED_COLOR = '#565f89';
export const FAINT_COLOR = '#3b4261';
export const ACCENT_BLUE = '#7aa2f7';

/** Zone initial for the ASCII chip (G/Y/O/R). */
export const ZONE_INITIALS: Readonly<Record<ZoneName, string>> = Object.freeze({
  green: 'G',
  yellow: 'Y',
  orange: 'O',
  red: 'R',
});

// ── Usage bar: 22 cells inside ▕…▏, eighth-block partials, `·` remainder ──────

export const BAR_CELLS = 22;
const EIGHTH_BLOCKS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;
const BAR_REMAINDER = '·'; // U+00B7

/** 22-cell usage bar; `pct = null` renders the empty (unknown-state) bar. */
export function formatBar(pct: number | null, cells: number = BAR_CELLS): string {
  if (pct === null) return `▕${BAR_REMAINDER.repeat(cells)}▏`;
  const clamped = Math.min(100, Math.max(0, pct));
  const eighths = Math.round((clamped / 100) * cells * 8);
  const full = Math.floor(eighths / 8);
  const partial = eighths % 8;
  let bar = '█'.repeat(Math.min(full, cells));
  if (partial > 0 && full < cells) bar += EIGHTH_BLOCKS[partial - 1];
  bar += BAR_REMAINDER.repeat(cells - [...bar].length);
  return `▕${bar}▏`;
}

// ── Sparkline: last 12 samples, ramp ▁▂▃▄▅▆▇█ ─────────────────────────────────

const SPARK_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function formatSparkline(pcts: readonly number[], samples = 12): string {
  return pcts
    .slice(-samples)
    .map((pct) => {
      const index = Math.min(
        SPARK_RAMP.length - 1,
        Math.max(0, Math.floor((pct / 100) * SPARK_RAMP.length)),
      );
      return SPARK_RAMP[index];
    })
    .join('');
}

// ── Tokens: `94.2k/200k` (one decimal on used, integer window) ────────────────

export function formatTokens(tokensUsed: number, contextWindow: number): string {
  return `${(tokensUsed / 1000).toFixed(1)}k/${String(Math.round(contextWindow / 1000))}k`;
}

// ── Burn: `+1.2%/turn avg` ────────────────────────────────────────────────────

export function formatBurn(burn: number | null): string {
  if (burn === null) return '—';
  const sign = burn >= 0 ? '+' : '';
  return `${sign}${burn.toFixed(1)}%/turn avg`;
}

// ── ETA: `~11 turns→red` · `burn stable` · `handoff now` (in red) ─────────────

export function formatEta(
  zone: ZoneName,
  pct: number,
  burn: number | null,
  redThreshold: number,
): string {
  if (zone === 'red') return 'handoff now';
  const turns = turnsToRed(pct, burn, redThreshold);
  if (turns === null) return 'burn stable';
  return `~${String(turns)} turns→red`;
}

// ── Forecast box copy (design 1c) ─────────────────────────────────────────────

export function formatForecast(
  zone: ZoneName,
  pct: number,
  burn: number | null,
  redThreshold: number,
  secondsPerTurnValue: number | null,
): string {
  if (zone === 'red') return 'RED — capture a handoff summary now';
  const turns = turnsToRed(pct, burn, redThreshold);
  if (turns === null) return 'usage stable — keep prompting freely';
  if (secondsPerTurnValue === null) return `red in ~${String(turns)} turns`;
  const minutes = Math.max(1, Math.round((turns * secondsPerTurnValue) / 60));
  return `red in ~${String(turns)} turns (≈${String(minutes)} min at current burn)`;
}

// ── Data age: humanized seconds (`2s`, `31s`, `6m`, `3h`, `8d`) ───────────────

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
  return `${String(Math.floor(seconds / 86_400))}d`;
}

// ── ASCII fallback chip: `ctx [##########......] 47% Y` / `(ctx -- ?)` ────────

export const ASCII_CELLS = 16;

export function formatAscii(pct: number | null, zone: ZoneName | null): string {
  if (pct === null || zone === null) return '(ctx -- ?)';
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * ASCII_CELLS);
  const cells = '#'.repeat(filled) + '.'.repeat(ASCII_CELLS - filled);
  return `ctx [${cells}] ${String(Math.round(clamped))}% ${ZONE_INITIALS[zone]}`;
}

// ── ANSI helpers for the plain (non-Ink) status line ──────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Truecolor foreground wrap, only when enabled (TTY). */
export function colorize(text: string, hex: string, enabled: boolean): string {
  if (!enabled) return text;
  const [r, g, b] = hexToRgb(hex);
  return `[38;2;${String(r)};${String(g)};${String(b)}m${text}[39m`;
}

/** Bold wrap, only when enabled (TTY). */
export function boldText(text: string, enabled: boolean): string {
  return enabled ? `[1m${text}[22m` : text;
}
