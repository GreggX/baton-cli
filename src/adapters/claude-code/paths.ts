// T018 — Session-data path resolution for the Claude Code adapter.
//
// The session-data root comes from the BATON_CLAUDE_DIR environment variable
// (default `~/.claude`); a workspace's transcripts live at
// `<root>/projects/<encoded workspace path>/<session-id>.jsonl`, where the encoded
// path is the absolute workspace path with "/" replaced by "-" — exactly how
// Claude Code lays out its project directories.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Environment variable overriding the session-data root (default `~/.claude`). */
export const CLAUDE_DIR_ENV = 'BATON_CLAUDE_DIR';

/**
 * Resolve the session-data root: explicit argument, then BATON_CLAUDE_DIR,
 * then `~/.claude`. Relative values resolve against the current working directory.
 */
export function resolveClaudeDir(explicit?: string): string {
  const fromEnv = process.env[CLAUDE_DIR_ENV];
  const root = explicit ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined);
  return resolve(root ?? join(homedir(), '.claude'));
}

/** Encode a workspace path the way Claude Code does: absolute path, "/" → "-". */
export function encodeWorkspacePath(workspace: string): string {
  return resolve(workspace).replaceAll('/', '-');
}

/** Directory holding a workspace's session transcripts under a session-data root. */
export function projectDirFor(claudeDir: string, workspace: string): string {
  return join(claudeDir, 'projects', encodeWorkspacePath(workspace));
}

/** Full path of one session's transcript file. */
export function transcriptPathFor(
  claudeDir: string,
  workspace: string,
  sessionId: string,
): string {
  return join(projectDirFor(claudeDir, workspace), `${sessionId}.jsonl`);
}
