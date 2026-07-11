// T026 — Session file watching (US1, FR-001).
//
// chokidar watches the workspace's whole project directory — the transcript AND its
// siblings — so both new activity in the current transcript and session rollover
// (a new <session-id>.jsonl appearing) surface as change events. Events are
// debounced (500 ms trailing) so bursts of writes coalesce into one refresh.
//
// A polling fallback stats the directory's transcripts every POLL seconds (default
// 5 — half the FR-001 10 s guarantee) and fires when the signature changes, covering
// file systems where native events are unreliable.
//
// Strictly read-only: watching and stat-ing only, never writing session data.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { watch } from 'chokidar';
import type { SessionRef } from '../../core/monitor/types.js';
import type { SessionSubscription } from '../../core/monitor/session-source.js';
import { projectDirFor, resolveClaudeDir } from './paths.js';

/** Trailing debounce applied to change events (ms). */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Polling fallback interval (seconds) — half the FR-001 refresh guarantee. */
export const DEFAULT_POLL_SECONDS = 5;

export interface WatchSessionOptions {
  /** Session-data root override; absent → BATON_CLAUDE_DIR, then ~/.claude. */
  claudeDir?: string | undefined;
  /** Trailing debounce for change events (default 500 ms). */
  debounceMs?: number | undefined;
  /** Polling fallback interval in seconds (default 5; CLI --interval caps 1–10). */
  pollIntervalSeconds?: number | undefined;
}

/** Stable signature of the project directory's transcripts (name:size:mtime). */
async function transcriptSignature(dir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of names) {
    try {
      const stats = await stat(join(dir, name));
      parts.push(`${name}:${String(stats.size)}:${String(stats.mtimeMs)}`);
    } catch {
      // file vanished between readdir and stat — its absence changes the signature
    }
  }
  return parts.join('|');
}

/**
 * Watch a session's project directory and invoke `onChange` (debounced) after any
 * transcript change or rollover. Returns a subscription whose `close()` is idempotent.
 */
export function watchSession(
  session: SessionRef,
  onChange: () => void,
  options: WatchSessionOptions = {},
): SessionSubscription {
  const dir = projectDirFor(resolveClaudeDir(options.claudeDir), session.workspace);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = (options.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS) * 1000;

  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    if (closed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange();
    }, debounceMs);
  };

  // Native events: any add/change/unlink inside the project directory.
  const watcher = watch(dir, { ignoreInitial: true });
  watcher.on('all', fire);
  watcher.on('error', () => {
    // native watching failed — the polling fallback below keeps refreshes alive
  });

  // Polling fallback: signature comparison every poll interval.
  let lastSignature: string | null = null;
  let polling = false;
  const pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void transcriptSignature(dir)
      .then((signature) => {
        if (lastSignature !== null && signature !== lastSignature) fire();
        lastSignature = signature;
      })
      .finally(() => {
        polling = false;
      });
  }, pollMs);
  void transcriptSignature(dir).then((signature) => {
    lastSignature ??= signature;
  });

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      clearInterval(pollTimer);
      await watcher.close();
    },
  };
}
