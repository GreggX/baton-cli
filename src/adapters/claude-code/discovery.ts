// T018 — Claude Code session discovery.
//
// The session-data root comes from the BATON_CLAUDE_DIR environment variable
// (default ~/.claude); transcripts for a workspace live at
// `<root>/projects/<encoded workspace path>/<session-id>.jsonl`, where the encoded
// path is the absolute workspace path with "/" replaced by "-" — exactly how
// Claude Code lays out its project directories.
//
// Everything here is strictly read-only with respect to session data
// (constitution Principle II) and deterministic: newest-transcript selection is
// driven by entry timestamps found in the transcripts themselves (file mtime is
// only a fallback for transcripts with no parseable timestamp), never by wall-clock
// calls in this module.
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { SessionRef } from '../../core/monitor/types.js';
import { sessionRefSchema } from '../../core/monitor/types.js';
import { projectDirFor, resolveClaudeDir } from './paths.js';
import { readTranscriptLines, textTimestampOf } from './transcript.js';

export {
  CLAUDE_DIR_ENV,
  encodeWorkspacePath,
  projectDirFor,
  resolveClaudeDir,
  transcriptPathFor,
} from './paths.js';

/** How the session to monitor is selected (mirrors the core port's options). */
export interface ResolveSessionInput {
  /** Workspace directory whose session data should be monitored. */
  workspace: string;
  /** Explicit session id override; absent → newest transcript wins. */
  sessionId?: string | undefined;
  /** Session-data root override; absent → BATON_CLAUDE_DIR, then ~/.claude. */
  claudeDir?: string | undefined;
}

interface SessionCandidate {
  sessionId: string;
  filePath: string;
  /** ISO datetime — newest entry timestamp, or file mtime when none is parseable. */
  lastActivityAt: string;
  /** Model id of the latest assistant entry that names one, or null. */
  modelId: string | null;
}

async function inspectTranscript(filePath: string): Promise<SessionCandidate> {
  const sessionId = basename(filePath, '.jsonl');
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    raw = '';
  }

  let lastTimestamp: string | null = null;
  let modelId: string | null = null;
  for (const { value } of readTranscriptLines(raw).entries) {
    const timestamp = textTimestampOf(value);
    if (timestamp !== null) lastTimestamp = timestamp;
    if (value.type === 'assistant') {
      const message = value.message;
      if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
        const model = (message as Record<string, unknown>)['model'];
        if (typeof model === 'string' && model !== '') modelId = model;
      }
    }
  }

  let lastActivityAt = lastTimestamp;
  if (lastActivityAt === null) {
    const stats = await stat(filePath);
    lastActivityAt = stats.mtime.toISOString();
  }
  return { sessionId, filePath, lastActivityAt, modelId };
}

/** All session transcripts for a workspace, newest activity first (stable order). */
export async function discoverSessions(
  input: Pick<ResolveSessionInput, 'workspace' | 'claudeDir'>,
): Promise<SessionCandidate[]> {
  const dir = projectDirFor(resolveClaudeDir(input.claudeDir), input.workspace);
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name)
      .sort(); // deterministic base order before activity sort
  } catch {
    return []; // no project directory → no sessions
  }

  const candidates = await Promise.all(
    names.map((name) => inspectTranscript(join(dir, name))),
  );
  return candidates.sort((a, b) => {
    const byActivity = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    if (byActivity !== 0) return byActivity;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/**
 * Resolve the session to monitor for a workspace: the explicit session id when
 * given, otherwise the transcript with the newest activity. Returns null when the
 * workspace has no session data or the override matches nothing (CLI exit code 3).
 */
export async function resolveSession(input: ResolveSessionInput): Promise<SessionRef | null> {
  const sessions = await discoverSessions(input);
  const chosen =
    input.sessionId !== undefined
      ? sessions.find((candidate) => candidate.sessionId === input.sessionId)
      : sessions[0];
  if (chosen === undefined) return null;
  return sessionRefSchema.parse({
    id: chosen.sessionId,
    workspace: resolve(input.workspace),
    modelId: chosen.modelId,
    lastActivityAt: chosen.lastActivityAt,
  });
}
