// T043 — `baton context scan` (US3, FR-008/FR-012).
//
// Surfaces artifact-save candidates via the deterministic rule registry. Human
// output is the design 3b table: numbered rows with a colored rule pill per
// category, `matched "<phrase>"`, the sentence-bound excerpt with the match
// bolded, and its source (`turn N · role`); the output ends with the design 3c
// `fingerprint <hash>` line. The empty result is explicit (US3-AS3): the 3c
// `○ No artifact candidates found.` report naming the rules checked — never
// silence. `--json` emits the scanReportSchema contract document; reruns over
// identical content are byte-identical (SC-005). Read-only: scanning writes
// nothing, ever.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { createClaudeCodeSessionSource } from '../../adapters/claude-code/session-source.js';
import { CATEGORY_COLORS, rulesForCategories } from '../../core/heuristics/rules.js';
import type { ScanReport } from '../../core/heuristics/scanner.js';
import {
  blockForSpan,
  findMatch,
  scanContent,
  scanFingerprint,
  scanReportSchema,
} from '../../core/heuristics/scanner.js';
import type {
  ArtifactCandidate,
  HeuristicRule,
  RuleCategory,
} from '../../core/heuristics/types.js';
import { ruleCategorySchema } from '../../core/heuristics/types.js';
import type { ScanBlock, SessionSource } from '../../core/monitor/session-source.js';
import type { SessionRef } from '../../core/monitor/types.js';
import { boldText, colorize } from '../ui/format.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, jsonResult, result } from '../output.js';

interface ScanOptions extends GlobalOptions {
  category?: string[];
}

/** Register `scan` under the `context` command group. */
export function registerScanCommand(context: Command): void {
  context
    .command('scan')
    .description('Surface artifact candidates via deterministic heuristic rules')
    .option(
      '--category <category...>',
      'only check rules of these categories (decision|conclusion|constraint|result|task|question; repeatable, default all)',
    )
    .action(async (_opts: ScanOptions, command: Command) => {
      await runScan(command);
    });
}

/** Parse/validate --category values; invalid → null (caller exits 2). */
export function parseCategories(values: string[] | undefined): RuleCategory[] | null {
  if (values === undefined) return [];
  const categories: RuleCategory[] = [];
  for (const value of values) {
    const parsed = ruleCategorySchema.safeParse(value);
    if (!parsed.success) return null;
    categories.push(parsed.data);
  }
  return categories;
}

/** One full deterministic scan of a session — shared by `scan` and `save`. */
export interface ScanRun {
  session: SessionRef;
  blocks: ScanBlock[];
  rules: HeuristicRule[];
  candidates: ArtifactCandidate[];
  fingerprint: string;
}

/** Resolve the session and scan its content with the given rules (read-only). */
export async function performScan(
  source: SessionSource,
  options: { workspace: string; sessionId?: string | undefined; rules: HeuristicRule[] },
): Promise<ScanRun | null> {
  const session = await source.resolveSession({
    workspace: options.workspace,
    sessionId: options.sessionId,
  });
  if (session === null) return null;
  const blocks = await source.contentForScan(session);
  const candidates = scanContent({ sessionId: session.id, blocks, rules: options.rules });
  return {
    session,
    blocks,
    rules: options.rules,
    candidates,
    fingerprint: scanFingerprint(candidates),
  };
}

async function runScan(command: Command): Promise<void> {
  const opts = command.optsWithGlobals<ScanOptions>();
  const workspace = resolve(opts.workspace ?? process.cwd());

  const categories = parseCategories(opts.category);
  if (categories === null) {
    diagnostic(
      `invalid --category "${(opts.category ?? []).join(', ')}" — must be one of ${ruleCategorySchema.options.join('|')}`,
    );
    process.exitCode = EXIT.invalidInvocation;
    return;
  }
  const rules = rulesForCategories(categories.length > 0 ? categories : undefined);

  const source = createClaudeCodeSessionSource();
  const run = await performScan(source, { workspace, sessionId: opts.session, rules });
  if (run === null) {
    diagnostic(`no session found for workspace ${workspace}`);
    process.exitCode = EXIT.noSession;
    return;
  }

  if (opts.json === true) {
    const report: ScanReport = scanReportSchema.parse({
      sessionId: run.session.id,
      fingerprint: run.fingerprint,
      rulesChecked: run.rules.map((rule) => rule.id),
      candidates: run.candidates,
    });
    jsonResult(report);
  } else {
    for (const line of humanScanLines(run, process.stdout.isTTY === true)) result(line);
  }
  process.exitCode = EXIT.ok; // exit 0 includes the explicit empty result
}

// ── Human rendering (design 3b table + 3c empty state) ────────────────────────

/** `matched "we decided"` — lowercased matched text, straight quotes. */
export function matchedPhraseLabel(rule: HeuristicRule, excerpt: string): string {
  const match = findMatch(rule, excerpt);
  return match === null ? rule.id : match.phrase.toLowerCase();
}

/** Excerpt with the matched span bolded (design 3b: match bolded). */
function excerptWithBoldMatch(rule: HeuristicRule, excerpt: string, tty: boolean): string {
  const match = findMatch(rule, excerpt);
  if (match === null) return excerpt;
  const before = excerpt.slice(0, match.index);
  const after = excerpt.slice(match.index + match.phrase.length);
  return `${before}${boldText(match.phrase, tty)}${after}`;
}

/** `turn N · role` source stamp for a candidate (design 3b EXCERPT · SOURCE). */
function sourceStamp(blocks: readonly ScanBlock[], candidate: ArtifactCandidate): string {
  const located = blockForSpan(blocks, candidate.span);
  return located === null ? `lines ${String(candidate.span.startLine)}–${String(candidate.span.endLine)}` : `turn ${String(located.turn)} · ${located.block.role}`;
}

function humanScanLines(run: ScanRun, tty: boolean): string[] {
  const { blocks, rules, candidates, fingerprint } = run;
  const ruleIndex = new Map(rules.map((rule) => [rule.id, rule]));
  const lines: string[] = [
    `⏺ scanned ${String(blocks.length)} turns · ${String(rules.length)} rules · ${String(candidates.length)} candidates`,
  ];

  if (candidates.length === 0) {
    // Design 3c: the empty result is a report, not silence (US3-AS3).
    const categories = [...new Set(rules.map((rule) => rule.category))].join(' · ');
    lines.push(
      '○ No artifact candidates found.',
      `None of the ${String(rules.length)} rules (${categories}) matched this session's content. Nothing was written to the workspace.`,
    );
  } else {
    for (const [index, candidate] of candidates.entries()) {
      const rule = ruleIndex.get(candidate.ruleId);
      if (rule === undefined) continue;
      const pill = colorize(candidate.ruleId, CATEGORY_COLORS[rule.category], tty);
      lines.push(
        `${String(index + 1)}  ${pill} · matched "${matchedPhraseLabel(rule, candidate.excerpt)}"`,
        `   "${excerptWithBoldMatch(rule, candidate.excerpt, tty)}" · ${sourceStamp(blocks, candidate)}`,
      );
    }
  }

  lines.push(`fingerprint ${fingerprint}`); // output ends with the fingerprint (3c)
  return lines;
}
