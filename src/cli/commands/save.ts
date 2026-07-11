// T046 — `baton context save` (US3, FR-009).
//
// Two modes per the contract:
//   - explicit `baton context save <candidate-id>…`: every id is validated
//     against a fresh deterministic scan BEFORE anything is written — an
//     unknown id exits 2 with the offending id on stderr and leaves no file
//     behind (nothing partially written);
//   - interactive review (TTY, no ids, no --json): the design 3a Ink loop —
//     accept/reject one candidate at a time; only accepted candidates are
//     persisted, rejected ones leave no trace (SC-004).
//
// Writing artifacts is the explicit user action FR-007 requires; the artifact
// store performs the writes (`.baton/artifacts/…`), everything else here is
// read-only. `--json` prints the saveReportSchema document.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { createClaudeCodeSessionSource } from '../../adapters/claude-code/session-source.js';
import type { PlannedArtifact } from '../../core/artifacts/store.js';
import { planArtifactPaths, saveArtifacts, saveReportSchema } from '../../core/artifacts/store.js';
import { CATEGORY_COLORS, ruleById } from '../../core/heuristics/rules.js';
import { HEURISTIC_RULES } from '../../core/heuristics/rules.js';
import { blockForSpan, findMatch } from '../../core/heuristics/scanner.js';
import type { ArtifactCandidate, HeuristicRule } from '../../core/heuristics/types.js';
import type { ScanBlock } from '../../core/monitor/session-source.js';
import type { ReviewItem } from '../ui/CandidateReview.js';
import { CandidateReview } from '../ui/CandidateReview.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, jsonResult, result } from '../output.js';
import type { ScanRun } from './scan.js';
import { matchedPhraseLabel, performScan } from './scan.js';

/** Register `save` under the `context` command group. */
export function registerSaveCommand(context: Command): void {
  context
    .command('save [candidate-ids...]')
    .description('Persist accepted artifact candidates to .baton/artifacts/')
    .action(async (_ids: string[], _opts: GlobalOptions, command: Command) => {
      await runSave(command, _ids);
    });
}

async function runSave(command: Command, ids: string[]): Promise<void> {
  const opts = command.optsWithGlobals<GlobalOptions>();
  const workspace = resolve(opts.workspace ?? process.cwd());

  const source = createClaudeCodeSessionSource();
  const run = await performScan(source, {
    workspace,
    sessionId: opts.session,
    rules: [...HEURISTIC_RULES],
  });
  if (run === null) {
    diagnostic(`no session found for workspace ${workspace}`);
    process.exitCode = EXIT.noSession;
    return;
  }

  // The command's single wall-clock read: shown paths == written paths.
  const savedAt = new Date();

  if (ids.length > 0) {
    saveExplicit(run, workspace, ids, savedAt, opts.json === true);
    return;
  }

  const interactive =
    opts.json !== true && process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!interactive) {
    diagnostic(
      'no candidate ids given — pass explicit ids (`baton context save <candidate-id>…`) or run in an interactive terminal for the review loop',
    );
    process.exitCode = EXIT.invalidInvocation;
    return;
  }
  await runInteractiveReview(run, workspace, savedAt);
}

/** Candidate + display context → the store's planned-artifact input. */
function planCandidate(
  blocks: readonly ScanBlock[],
  candidate: ArtifactCandidate,
  rule: HeuristicRule,
): PlannedArtifact {
  const located = blockForSpan(blocks, candidate.span);
  const match = findMatch(rule, candidate.excerpt);
  return {
    candidate,
    rule,
    matchedPhrase: match === null ? null : match.phrase.toLowerCase(),
    turn: located === null ? null : located.turn,
    turnTimestamp: located?.block.timestamp ?? null,
  };
}

// ── Explicit-id mode ──────────────────────────────────────────────────────────

function saveExplicit(
  run: ScanRun,
  workspace: string,
  ids: string[],
  savedAt: Date,
  json: boolean,
): void {
  const byId = new Map(run.candidates.map((candidate) => [candidate.id, candidate]));

  // Validate EVERY id before writing ANYTHING — nothing partially written.
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    for (const id of unknown) diagnostic(`unknown candidate id: ${id}`);
    process.exitCode = EXIT.invalidInvocation;
    return;
  }

  const planned: PlannedArtifact[] = [];
  for (const id of ids) {
    const candidate = byId.get(id);
    if (candidate === undefined) continue; // unreachable after validation
    const rule = ruleById(candidate.ruleId);
    if (rule === undefined) continue;
    planned.push(planCandidate(run.blocks, { ...candidate, status: 'accepted' }, rule));
  }

  const artifacts = saveArtifacts(workspace, planned, savedAt);
  if (json) {
    jsonResult(
      saveReportSchema.parse({
        saved: artifacts.map((artifact) => ({
          candidateId: artifact.candidateId,
          path: artifact.path,
        })),
      }),
    );
  } else {
    for (const artifact of artifacts) result(`+ ${artifact.path}`);
  }
  process.exitCode = EXIT.ok;
}

// ── Interactive review (design 3a) ────────────────────────────────────────────

async function runInteractiveReview(
  run: ScanRun,
  workspace: string,
  savedAt: Date,
): Promise<void> {
  const header = `⏺ scanned ${String(run.blocks.length)} turns · ${String(run.rules.length)} rules · ${String(run.candidates.length)} candidates · fingerprint ${run.fingerprint}`;

  if (run.candidates.length === 0) {
    // Nothing to review — the explicit empty report, never silence (US3-AS3).
    result(header);
    result('○ No artifact candidates found.');
    process.exitCode = EXIT.ok;
    return;
  }

  const withRules = run.candidates.flatMap((candidate) => {
    const rule = ruleById(candidate.ruleId);
    return rule === undefined ? [] : [{ candidate, rule }];
  });
  // `on accept → path`: computed with the same savedAt used for the writes.
  const targetPaths = planArtifactPaths(
    withRules.map(({ candidate, rule }) => planCandidate(run.blocks, candidate, rule)),
    savedAt.toISOString(),
  );
  const items: ReviewItem[] = withRules.map(({ candidate, rule }, index) => {
    const located = blockForSpan(run.blocks, candidate.span);
    const match = findMatch(rule, candidate.excerpt);
    return {
      candidate,
      category: rule.category,
      color: CATEGORY_COLORS[rule.category],
      matchedPhrase: match === null ? null : matchedPhraseLabel(rule, candidate.excerpt),
      location:
        located === null
          ? `lines ${String(candidate.span.startLine)}–${String(candidate.span.endLine)}`
          : `turn ${String(located.turn)} · ${located.block.role}`,
      pre: match === null ? candidate.excerpt : candidate.excerpt.slice(0, match.index),
      match: match === null ? '' : match.phrase,
      post: match === null ? '' : candidate.excerpt.slice(match.index + match.phrase.length),
      targetPath: targetPaths[index] ?? '',
    };
  });

  let resolveAccepted: (acceptedIds: string[]) => void = () => undefined;
  const accepted = new Promise<string[]>((resolveDone) => {
    resolveAccepted = resolveDone;
  });
  let written: readonly string[] | null = null;
  const element = (): ReturnType<typeof createElement> =>
    createElement(CandidateReview, {
      header,
      items,
      written,
      onComplete: (acceptedIds: string[]) => {
        resolveAccepted(acceptedIds);
      },
    });

  const app = render(element(), { exitOnCtrlC: true });
  const acceptedIds = await accepted;

  // Only accepted candidates are written; rejected ones leave no file (FR-009).
  const acceptedSet = new Set(acceptedIds);
  const planned = withRules
    .filter(({ candidate }) => acceptedSet.has(candidate.id))
    .map(({ candidate, rule }) =>
      planCandidate(run.blocks, { ...candidate, status: 'accepted' }, rule),
    );
  const artifacts = planned.length > 0 ? saveArtifacts(workspace, planned, savedAt) : [];
  written = artifacts.map((artifact) => artifact.path);
  app.rerender(element());
  app.unmount(); // completion box stays as the final frame
  await app.waitUntilExit();
  process.exitCode = EXIT.ok;
}
