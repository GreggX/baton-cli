// Claude Code SessionSource implementation — the adapter side of the core port
// (Principle III: all agent-specific knowledge stays behind this seam).
// Composes discovery (T018), the transcript reader (T019), and the watcher (T026).
// Strictly read-only with respect to session data.
import type {
  ResolveSessionOptions,
  ScanBlock,
  SessionSource,
  SessionSubscription,
} from '../../core/monitor/session-source.js';
import type {
  ReadingUnavailable,
  SessionRef,
  UsageReading,
} from '../../core/monitor/types.js';
import { readScanBlocks } from './content.js';
import { resolveSession } from './discovery.js';
import { readUsage, readUsageHistory } from './transcript.js';
import { watchSession } from './watcher.js';

export interface ClaudeCodeSessionSourceOptions {
  /** Session-data root override; absent → BATON_CLAUDE_DIR, then ~/.claude. */
  claudeDir?: string | undefined;
  /** Exact model-id → context-window overrides (config-overridable map, R2). */
  modelWindows?: Readonly<Record<string, number>> | undefined;
  /** Watcher debounce override (default 500 ms). */
  debounceMs?: number | undefined;
  /** Watcher polling fallback interval in seconds (default 5, CLI-capped 1–10). */
  pollIntervalSeconds?: number | undefined;
}

/** Build the Claude Code implementation of the core SessionSource port. */
export function createClaudeCodeSessionSource(
  options: ClaudeCodeSessionSourceOptions = {},
): SessionSource {
  return {
    resolveSession(resolveOptions: ResolveSessionOptions): Promise<SessionRef | null> {
      return resolveSession({
        workspace: resolveOptions.workspace,
        sessionId: resolveOptions.sessionId,
        claudeDir: options.claudeDir,
      });
    },

    currentReading(session: SessionRef): Promise<UsageReading | ReadingUnavailable> {
      return readUsage(session, {
        claudeDir: options.claudeDir,
        modelWindows: options.modelWindows,
      });
    },

    usageHistory(session: SessionRef): Promise<UsageReading[]> {
      return readUsageHistory(session, {
        claudeDir: options.claudeDir,
        modelWindows: options.modelWindows,
      });
    },

    // T041 — user+assistant text with transcript line spans, read-only (FR-008).
    contentForScan(session: SessionRef): Promise<ScanBlock[]> {
      return readScanBlocks(session, { claudeDir: options.claudeDir });
    },

    subscribeToChanges(session: SessionRef, onChange: () => void): SessionSubscription {
      return watchSession(session, onChange, {
        claudeDir: options.claudeDir,
        debounceMs: options.debounceMs,
        pollIntervalSeconds: options.pollIntervalSeconds,
      });
    },
  };
}
