// T052 — `baton context handoff` (US4, FR-010).
//
// Explicit-invocation-only (FR-007): red recommends a handoff, nothing ever
// auto-runs it. Available in any zone (4d) — in green a note says the handoff
// isn't needed yet, and the file is written anyway.
//
// Design 4a progressive output while assembling (stderr — progress never lands
// on stdout): collecting → task state → decisions/artifacts → verifying
// artifacts on disk "n/n present"; then the result on stdout — `+ <path>` and
// the `⏺ HANDOFF READY` completion box (human), or the {path, sessionId,
// artifactCount} contract document (--json).
//
// Interactive TTY (no --json/--yes): the derived draft is shown for
// confirm/cancel — optionally amended in $EDITOR — before the SINGLE write.
// Non-TTY, --json, or --yes writes the derived draft directly. --out overrides
// the default `.baton/handoff/<ts>-handoff.md` location.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Command } from 'commander';
import { createClaudeCodeSessionSource } from '../../adapters/claude-code/session-source.js';
import { loadConfig } from '../../core/config/loader.js';
import type { HandoffDraft, HandoffMeta } from '../../core/handoff/summary.js';
import {
  assembleHandoff,
  handoffRelativePath,
  handoffReportSchema,
  readSavedArtifacts,
  renderHandoffMarkdown,
  taskStateSummary,
  verifyArtifacts,
  writeHandoffFile,
} from '../../core/handoff/summary.js';
import { HEURISTIC_RULES } from '../../core/heuristics/rules.js';
import { readStatus } from '../../core/monitor/reader.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, jsonResult, result } from '../output.js';
import { formatTokens } from '../ui/format.js';
import { rejectionLines } from './config.js';

/** Design 4d green-zone note — the recommendation is zone-driven, the command is not. */
export const GREEN_ZONE_NOTE =
  "○ note: you're in green — a handoff isn't needed yet. Writing it anyway; the recommendation is zone-driven, the command is not.";

/** Design 4a completion box headline. */
export const HANDOFF_READY_LINE =
  '⏺ HANDOFF READY — this session can end without losing state';

interface HandoffOptions extends GlobalOptions {
  out?: string;
  yes?: boolean;
}

/** Register `handoff` under the `context` command group. */
export function registerHandoffCommand(context: Command): void {
  context
    .command('handoff')
    .description('Generate a handoff summary file for starting a fresh session')
    .option('--out <path>', 'write the handoff here (default .baton/handoff/<ts>-handoff.md)')
    .option('--yes', 'skip the draft review and write the derived draft directly')
    .action(async (_opts: HandoffOptions, command: Command) => {
      await runHandoff(command);
    });
}

async function runHandoff(command: Command): Promise<void> {
  const opts = command.optsWithGlobals<HandoffOptions>();
  const workspace = resolve(opts.workspace ?? process.cwd());

  const config = loadConfig(workspace);
  if (config.errors.length > 0) {
    // Tolerated-fallback path: warn on stderr, continue on defaults (FR-003).
    for (const line of rejectionLines(config.errors)) diagnostic(line);
  }

  // The command's single wall-clock read: meta timestamp == file name stamp.
  const now = new Date();
  const source = createClaudeCodeSessionSource();
  const status = await readStatus(source, {
    workspace,
    sessionId: opts.session,
    thresholds: config.thresholds,
    now,
  });
  const session = status.session;
  if (session === null) {
    diagnostic(`no session found for workspace ${workspace}`);
    process.exitCode = EXIT.noSession;
    return;
  }

  const reading = status.state === 'ok' ? status.reading : null;
  const zone = status.state === 'ok' ? status.zone : null;
  const blocks = await source.contentForScan(session);

  // 4a step 1 — collecting.
  const usagePart =
    reading !== null && zone !== null
      ? `${formatTokens(reading.tokensUsed, reading.contextWindow)} · zone ${zone}`
      : 'usage unknown';
  diagnostic(`⏺ collecting — ${String(blocks.length)} turns · ${usagePart}`);

  // 4d — green never blocks the capability, it only annotates it.
  if (zone === 'green') diagnostic(GREEN_ZONE_NOTE);

  const artifacts = readSavedArtifacts(workspace, session.id);
  const draft = await assembleHandoff({
    sessionId: session.id,
    blocks,
    rules: [...HEURISTIC_RULES],
    artifacts,
  });

  // 4a steps 2–4 — task state, decisions/artifacts, on-disk verification.
  diagnostic(`⏺ task state ${taskStateSummary(draft.taskState)}${userTurnRange(draft)}`);
  diagnostic(
    `⏺ key decisions ${String(draft.decisions.length)} · artifact pointers ${String(draft.artifactRefs.length)}`,
  );
  const verification = verifyArtifacts(workspace, artifacts);
  diagnostic(
    `⏺ verifying artifacts on disk — ${String(verification.present)}/${String(verification.total)} present`,
  );

  const meta: HandoffMeta = {
    workspacePath: workspace,
    writtenAtIso: now.toISOString(),
    reading,
    zone,
    turns: blocks.length,
    verification,
  };
  let content = renderHandoffMarkdown(draft, meta);

  // Resolve the target: --out (absolute, or relative to the workspace) or the
  // default `.baton/handoff/<ts>-handoff.md`.
  const absolutePath =
    opts.out !== undefined
      ? isAbsolute(opts.out)
        ? opts.out
        : join(workspace, opts.out)
      : join(workspace, handoffRelativePath(meta.writtenAtIso));
  const displayPath = absolutePath.startsWith(workspace + sep)
    ? relative(workspace, absolutePath)
    : absolutePath;

  // Interactive TTY: review/amend the draft before the single write (FR-010).
  const interactive =
    opts.json !== true &&
    opts.yes !== true &&
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true;
  if (interactive) {
    const reviewed = await reviewDraft(content, displayPath);
    if (reviewed === null) {
      diagnostic('cancelled — nothing written');
      process.exitCode = EXIT.ok;
      return;
    }
    content = reviewed;
  }

  writeHandoffFile(absolutePath, content); // the single write

  if (opts.json === true) {
    jsonResult(
      handoffReportSchema.parse({
        path: displayPath,
        sessionId: session.id,
        artifactCount: draft.artifactRefs.length,
      }),
    );
  } else {
    const lineCount = content.split('\n').length - 1; // content ends with \n
    result(`+ ${displayPath} · ${String(lineCount)} lines · plain markdown`);
    result(HANDOFF_READY_LINE);
  }
  process.exitCode = EXIT.ok;
}

/** `— from turns 1–3` range of the user turns the task state derived from. */
function userTurnRange(draft: HandoffDraft): string {
  const turns = draft.taskState
    .map((item) => /^turn (\d+) · user$/.exec(item.source)?.[1])
    .filter((turn): turn is string => turn !== undefined)
    .map(Number);
  if (turns.length === 0) return '';
  return ` — from turns ${String(Math.min(...turns))}–${String(Math.max(...turns))}`;
}

// ── Interactive draft review (TTY only) ───────────────────────────────────────

/**
 * Show the derived draft and ask before the single write: [y] write, [n]
 * cancel (nothing written), [e] amend in $EDITOR then confirm the amended
 * draft. Prompts go to stderr — stdout stays reserved for results.
 */
async function reviewDraft(content: string, displayPath: string): Promise<string | null> {
  let draft = content;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      process.stderr.write(`\n${draft}\n`);
      const answer = (
        await rl.question(`write handoff to ${displayPath}? [y] write · [n] cancel · [e] edit in $EDITOR `)
      )
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes' || answer === '') return draft;
      if (answer === 'n' || answer === 'no') return null;
      if (answer === 'e' || answer === 'edit') {
        const edited = editInEditor(draft);
        if (edited !== null) draft = edited;
      }
    }
  } finally {
    rl.close();
  }
}

/** Open the draft in $EDITOR; null when unset or the edit failed. */
function editInEditor(draft: string): string | null {
  const editor = process.env['EDITOR'];
  if (editor === undefined || editor === '') {
    diagnostic('$EDITOR is not set — [y] to write the draft as-is, [n] to cancel');
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'baton-handoff-draft-'));
  const file = join(dir, 'handoff-draft.md');
  try {
    writeFileSync(file, draft);
    const proc = spawnSync(editor, [file], { stdio: 'inherit' });
    if (proc.status !== 0) {
      diagnostic(`$EDITOR exited with status ${String(proc.status ?? 'unknown')} — draft unchanged`);
      return null;
    }
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
