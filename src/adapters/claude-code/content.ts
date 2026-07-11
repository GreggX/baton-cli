// T041 — Claude Code content extraction for heuristic scanning (FR-008).
//
// Reads a session transcript and produces the core ScanBlock list: one block
// per user/assistant entry that carries plain text, with the entry's 1-indexed
// transcript line numbers as the span (JSONL: one entry per line, so a block's
// startLine equals its endLine) and the entry timestamp for provenance.
//
// Strictly read-only with respect to session data (Principle II) and
// deterministic: content order is transcript order, nothing is sampled, no
// clock is consulted (FR-012).
import { readFile } from 'node:fs/promises';
import type { ScanBlock } from '../../core/monitor/session-source.js';
import type { SessionRef } from '../../core/monitor/types.js';
import { resolveClaudeDir, transcriptPathFor } from './paths.js';
import { readTranscriptLines, textOf, textTimestampOf } from './transcript.js';

export interface ReadScanBlocksOptions {
  /** Session-data root override; absent → BATON_CLAUDE_DIR, then ~/.claude. */
  claudeDir?: string | undefined;
}

/**
 * Full session content for heuristic scanning, in stable transcript order.
 * User and assistant text only; entries with no plain text (tool traffic,
 * summaries, malformed lines) contribute nothing. Missing transcript ⇒ [].
 */
export async function readScanBlocks(
  session: SessionRef,
  options: ReadScanBlocksOptions = {},
): Promise<ScanBlock[]> {
  const path = transcriptPathFor(
    resolveClaudeDir(options.claudeDir),
    session.workspace,
    session.id,
  );

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return []; // no transcript → nothing to scan (never fatal, never fabricated)
  }

  const blocks: ScanBlock[] = [];
  for (const { line, value } of readTranscriptLines(raw).entries) {
    if (value.type !== 'user' && value.type !== 'assistant') continue;
    const text = textOf(value);
    if (text === '') continue;
    blocks.push({
      role: value.type,
      text,
      startLine: line,
      endLine: line,
      timestamp: textTimestampOf(value),
    });
  }
  return blocks;
}
