// T019 — Claude Code transcript reader.
//
// Tolerant JSONL parsing (zod loose/passthrough schemas — unknown fields and unknown
// entry types survive; malformed lines are skipped, never fatal), usage extraction
// from the latest assistant `message.usage`, a config-overridable model→window map
// with a conservative 200k default that marks readings ESTIMATED, and a chars/4
// estimation fallback (also labeled estimated) when no usage accounting exists.
//
// Read-only with respect to session data, and deterministic: reading timestamps come
// from the transcript entries themselves — no Date.now(), no randomness (FR-012/013).
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ReadingUnavailable, SessionRef, UsageReading } from '../../core/monitor/types.js';
import { computePct, usageReadingSchema } from '../../core/monitor/types.js';
import { estimateTokens } from '../../lib/estimate.js';
import { resolveClaudeDir, transcriptPathFor } from './paths.js';

// ── Model → context window map (R2) ──────────────────────────────────────────

/** Conservative fallback window for unknown/absent model ids — readings using it are estimated. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Extended-context marker Claude Code appends to model ids (e.g. `claude-sonnet-4-5[1m]`). */
export const EXTENDED_CONTEXT_MARKER = '[1m]';

/** Window of extended-context (`[1m]`) model variants. */
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** Known model-id prefixes → context window. Data, not code; overridable per call. */
export const DEFAULT_MODEL_WINDOWS: readonly { idPrefix: string; contextWindow: number }[] = [
  { idPrefix: 'claude-opus-4', contextWindow: 200_000 },
  { idPrefix: 'claude-sonnet-4', contextWindow: 200_000 },
  { idPrefix: 'claude-haiku-4', contextWindow: 200_000 },
  { idPrefix: 'claude-3-7-sonnet', contextWindow: 200_000 },
  { idPrefix: 'claude-3-5-sonnet', contextWindow: 200_000 },
  { idPrefix: 'claude-3-5-haiku', contextWindow: 200_000 },
];

export interface ResolvedWindow {
  contextWindow: number;
  /** false → the window was assumed, and the reading must be labeled estimated. */
  known: boolean;
}

/**
 * Resolve a model id to its context window.
 * Precedence: caller override map (exact id) → extended-context `[1m]` marker →
 * known prefix in the default map → conservative 200k default marked NOT known.
 */
export function resolveContextWindow(
  modelId: string | null,
  overrides?: Readonly<Record<string, number>>,
): ResolvedWindow {
  if (modelId !== null) {
    const override = overrides?.[modelId];
    if (override !== undefined) return { contextWindow: override, known: true };
    if (modelId.includes(EXTENDED_CONTEXT_MARKER)) {
      return { contextWindow: EXTENDED_CONTEXT_WINDOW, known: true };
    }
    for (const entry of DEFAULT_MODEL_WINDOWS) {
      if (modelId.startsWith(entry.idPrefix)) {
        return { contextWindow: entry.contextWindow, known: true };
      }
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, known: false };
}

// ── Tolerant JSONL parsing ────────────────────────────────────────────────────

/** Usage accounting block of an assistant message (unknown fields pass through). */
export const usageBlockSchema = z.looseObject({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_input_tokens: z.number().int().min(0).optional(),
  cache_creation_input_tokens: z.number().int().min(0).optional(),
});
export type UsageBlock = z.infer<typeof usageBlockSchema>;

/**
 * Minimal shape gate for one transcript line: an object with a string `type`.
 * Everything else passes through untouched — the transcript schema is
 * undocumented, so the reader must tolerate fields (and types) it has never seen.
 */
export const transcriptEntrySchema = z.looseObject({
  type: z.string(),
  timestamp: z.unknown().optional(),
  message: z.unknown().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** A parsed transcript line with its 1-indexed position in the file. */
export interface ParsedLine {
  line: number;
  value: TranscriptEntry;
}

export interface ReadTranscriptResult {
  entries: ParsedLine[];
  /** 1-indexed numbers of malformed lines that were skipped. */
  skippedLines: number[];
}

const isoDatetime = z.iso.datetime({ offset: true });

/**
 * Parse raw JSONL transcript content, skipping malformed lines.
 * Blank lines are ignored (not counted as malformed). Pure function.
 */
export function readTranscriptLines(raw: string): ReadTranscriptResult {
  const entries: ParsedLine[] = [];
  const skippedLines: number[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.trim() === '') continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      skippedLines.push(lineNumber);
      continue;
    }
    const result = transcriptEntrySchema.safeParse(parsed);
    if (!result.success) {
      skippedLines.push(lineNumber);
      continue;
    }
    entries.push({ line: lineNumber, value: result.data });
  }
  return { entries, skippedLines };
}

/** The entry's ISO timestamp, when it carries a valid one. */
export function textTimestampOf(entry: TranscriptEntry): string | null {
  const result = isoDatetime.safeParse(entry.timestamp);
  return result.success ? result.data : null;
}

function messageOf(entry: TranscriptEntry): Record<string, unknown> | null {
  const message = entry.message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  return message as Record<string, unknown>;
}

/** Plain text of a user/assistant entry's message content blocks, or ''. */
export function textOf(entry: TranscriptEntry): string {
  if (entry.type !== 'user' && entry.type !== 'assistant') return '';
  const message = messageOf(entry);
  if (message === null) return '';
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text']);
    }
  }
  return parts.join('\n');
}

/** Usage total of an assistant entry: all four accounting fields summed, or null. */
export function usageTotalOf(entry: TranscriptEntry): number | null {
  if (entry.type !== 'assistant') return null;
  const message = messageOf(entry);
  if (message === null) return null;
  const result = usageBlockSchema.safeParse(message['usage']);
  if (!result.success) return null;
  const usage = result.data;
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function modelOf(entry: TranscriptEntry): string | null {
  const message = messageOf(entry);
  const model = message?.['model'];
  return typeof model === 'string' && model !== '' ? model : null;
}

// ── Reading production ────────────────────────────────────────────────────────

/**
 * Per-turn usage history: one UsageReading per assistant entry carrying a valid
 * usage block, in transcript order (oldest → newest). Feeds the deterministic
 * sparkline/burn/ETA derivations. Empty when the transcript has no usage
 * accounting at all. Read-only and deterministic, like everything here.
 */
export async function readUsageHistory(
  session: SessionRef,
  options: ReadUsageOptions = {},
): Promise<UsageReading[]> {
  const path = transcriptPathFor(
    resolveClaudeDir(options.claudeDir),
    session.workspace,
    session.id,
  );

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  const history: UsageReading[] = [];
  let lastTimestamp: string | null = null;
  for (const { value } of readTranscriptLines(raw).entries) {
    const timestamp = textTimestampOf(value);
    if (timestamp !== null) lastTimestamp = timestamp;
    const tokensUsed = usageTotalOf(value);
    if (tokensUsed === null) continue;
    const window = resolveContextWindow(
      modelOf(value) ?? session.modelId,
      options.modelWindows,
    );
    history.push(
      usageReadingSchema.parse({
        sessionId: session.id,
        tokensUsed,
        contextWindow: window.contextWindow,
        pct: computePct(tokensUsed, window.contextWindow),
        precision: window.known ? 'exact' : 'estimated',
        timestamp: timestamp ?? lastTimestamp ?? session.lastActivityAt,
      }),
    );
  }
  return history;
}

export interface ReadUsageOptions {
  /** Session-data root override; absent → BATON_CLAUDE_DIR, then ~/.claude. */
  claudeDir?: string | undefined;
  /** Exact model-id → context-window overrides (config-overridable map, R2). */
  modelWindows?: Readonly<Record<string, number>> | undefined;
}

function unavailable(sessionId: string, reason: string): ReadingUnavailable {
  return { sessionId, reason, lastGoodReading: null };
}

/**
 * Produce the latest usage reading for a session, or the explicit unavailable
 * state — never a fabricated reading (FR-011).
 *
 * - latest assistant `message.usage` → exact reading (estimated if the window
 *   had to be assumed for an unknown model, FR-013);
 * - no usage anywhere → chars/4 estimate over the reconstructed user+assistant
 *   text, always labeled estimated;
 * - no readable content at all → ReadingUnavailable with a reason.
 */
export async function readUsage(
  session: SessionRef,
  options: ReadUsageOptions = {},
): Promise<UsageReading | ReadingUnavailable> {
  const path = transcriptPathFor(
    resolveClaudeDir(options.claudeDir),
    session.workspace,
    session.id,
  );

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return unavailable(session.id, `transcript not found: ${path}`);
  }

  const { entries } = readTranscriptLines(raw);
  if (entries.length === 0) {
    return unavailable(session.id, 'transcript has no readable entries');
  }

  let lastTimestamp: string | null = null;
  for (const { value } of entries) {
    const timestamp = textTimestampOf(value);
    if (timestamp !== null) lastTimestamp = timestamp;
  }
  const fallbackTimestamp = lastTimestamp ?? session.lastActivityAt;

  // Latest assistant entry carrying a valid usage block wins (R1).
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const parsedLine = entries[index];
    if (parsedLine === undefined) continue;
    const entry = parsedLine.value;
    const tokensUsed = usageTotalOf(entry);
    if (tokensUsed === null) continue;
    const window = resolveContextWindow(
      modelOf(entry) ?? session.modelId,
      options.modelWindows,
    );
    return usageReadingSchema.parse({
      sessionId: session.id,
      tokensUsed,
      contextWindow: window.contextWindow,
      pct: computePct(tokensUsed, window.contextWindow),
      precision: window.known ? 'exact' : 'estimated',
      timestamp: textTimestampOf(entry) ?? fallbackTimestamp,
    });
  }

  // No usage accounting anywhere → chars/4 estimation fallback (R4), labeled estimated.
  const texts: string[] = [];
  for (const { value } of entries) {
    const text = textOf(value);
    if (text !== '') texts.push(text);
  }
  const reconstructed = texts.join('\n');
  if (reconstructed === '') {
    return unavailable(session.id, 'transcript has no readable conversation content');
  }
  const tokensUsed = estimateTokens(reconstructed);
  const window = resolveContextWindow(session.modelId, options.modelWindows);
  return usageReadingSchema.parse({
    sessionId: session.id,
    tokensUsed,
    contextWindow: window.contextWindow,
    pct: computePct(tokensUsed, window.contextWindow),
    precision: 'estimated',
    timestamp: fallbackTimestamp,
  });
}
