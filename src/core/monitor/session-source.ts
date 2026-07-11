// T015 — SessionSource port (Principle III: adapter-ready core).
// Core consumes this interface; agent-specific adapters (src/adapters/claude-code/)
// implement it. All agent knowledge — transcript layout, usage fields, model->window
// map — stays behind this seam. Session data is strictly read-only through this port.
import type { ReadingUnavailable, SessionRef, UsageReading } from './types.js';

/** How the monitored session is selected (CLI --workspace / --session overrides). */
export interface ResolveSessionOptions {
  /** Workspace directory whose session data should be monitored (default: cwd). */
  workspace: string;
  /** Explicit session id override; when absent the adapter picks the most recent session. */
  sessionId?: string | undefined;
}

/**
 * One contiguous block of scannable session text, mapped back to its location in the
 * session content so heuristic matches can report exact spans (FR-008).
 */
export interface ScanBlock {
  /** Who produced the text. */
  role: 'user' | 'assistant';
  /** Plain text content of the block. */
  text: string;
  /** 1-indexed first line of the block in the session content. */
  startLine: number;
  /** 1-indexed last line of the block in the session content. */
  endLine: number;
  /** ISO timestamp of the turn, when the session data carries one (provenance). */
  timestamp?: string | null;
}

/** Handle for an active change subscription. */
export interface SessionSubscription {
  /** Stop watching. Idempotent. */
  close(): Promise<void>;
}

/**
 * Port between core and an agent session adapter.
 *
 * Contract:
 * - every method is read-only with respect to session data (constitution Principle II);
 * - `currentReading` never fabricates: when no reading is producible it returns the
 *   explicit `ReadingUnavailable` state (FR-011);
 * - readings derived from inferred inputs are labeled `precision: "estimated"` (FR-013).
 */
export interface SessionSource {
  /**
   * Resolve the session to monitor for a workspace, or null when none exists
   * (CLI exit code 3: no session).
   */
  resolveSession(options: ResolveSessionOptions): Promise<SessionRef | null>;

  /** Latest usage measurement for the session, or the explicit unavailable state. */
  currentReading(session: SessionRef): Promise<UsageReading | ReadingUnavailable>;

  /**
   * Per-turn usage history from the session data, oldest → newest — one reading per
   * turn that carried usage accounting. Feeds the deterministic sparkline/burn/ETA
   * derivations (design 1a/1c). Optional capability: absent → no history derivable.
   */
  usageHistory?(session: SessionRef): Promise<UsageReading[]>;

  /** Full session content for heuristic scanning, in stable order (FR-012). */
  contentForScan(session: SessionRef): Promise<ScanBlock[]>;

  /**
   * Subscribe to session-change events (new activity, session rollover).
   * `onChange` fires after the underlying session data changed; the caller re-reads
   * via `currentReading`/`contentForScan`.
   */
  subscribeToChanges(session: SessionRef, onChange: () => void): SessionSubscription;
}
