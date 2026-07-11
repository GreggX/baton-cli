// T051 — HandoffSummary assembly + rendering (US4, FR-010).
//
// Derivation (data-model HandoffSummary):
//   - decisions: saved artifacts (matched back to candidates through their
//     provenance frontmatter) plus decision-category rule matches — a match with
//     no artifact stays in the file as "— captured here (no artifact saved)";
//   - task state: the most recent user requests — windowed to the last
//     TASK_STATE_WINDOW user turns, a named constant so the selection is
//     deterministic and auditable — plus task-category rule matches. Behind the
//     TaskStateSource port; the default implementation is this transcript
//     inference, and an SDD-framework adapter MAY later supply authoritative
//     task state without core changes (Principle III);
//   - open questions: question-category rule matches.
// Every derived item carries its [source: rule id + turn, or artifact path]
// (FR-010/FR-006). Assembly and rendering are pure functions of their inputs —
// no clock (written-at is injected), no randomness, no network (FR-012 spirit);
// the only reads are the workspace's own saved artifacts, and the only write is
// `writeHandoffFile`, invoked exactly once by the explicitly-requested handoff
// command (FR-007).
//
// Rendering follows design 4b verbatim: header meta (written-at · pct (zone) ·
// tokens · turns, the "reading this + linked artifacts ≈ Nk tokens" note),
// `## Task state` with ✓/◐/○ glyphs, `## Key decisions` numbered with artifact
// links, `## Saved artifacts (n/n verified on disk)`, `## Open questions`
// (FR-010; not mocked in 4b but required by the contract), `## Resume` 3 steps.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { estimateTokens } from '../../lib/estimate.js';
import { ARTIFACTS_RELATIVE_DIR, fileTimestamp } from '../artifacts/store.js';
import { blockForSpan, candidateId, scanContent, splitSentences } from '../heuristics/scanner.js';
import type { ArtifactCandidate, HandoffSections, HeuristicRule, Span } from '../heuristics/types.js';
import { handoffSectionsSchema, ruleCategorySchema, spanSchema } from '../heuristics/types.js';
import type { ScanBlock } from '../monitor/session-source.js';
import type { UsageReading, ZoneName } from '../monitor/types.js';

// ── Named derivation constants (deterministic and auditable) ──────────────────

/** Task state derives from the last N user turns (data-model TASK_STATE_WINDOW). */
export const TASK_STATE_WINDOW = 3;

/** Workspace-relative directory holding handoff summaries. */
export const HANDOFF_RELATIVE_DIR = join('.baton', 'handoff');

/** Design 4b task-state glyphs: ✓ done / ◐ in progress / ○ open. */
export const TASK_GLYPHS = Object.freeze({
  done: '✓ done',
  in_progress: '◐ in progress',
  open: '○ open',
} as const);

export type TaskStatus = keyof typeof TASK_GLYPHS;

// ── TaskStateSource port (Principle III) ──────────────────────────────────────

/** One task-state line: status, text, and the source that produced it (FR-010). */
export interface TaskStateItem {
  status: TaskStatus;
  text: string;
  /** `turn N · user` or `<ruleId> · turn N` */
  source: string;
}

export interface TaskStateInput {
  sessionId: string;
  /** session content in stable order (adapter-provided, read-only) */
  blocks: readonly ScanBlock[];
  /** full ordered rule registry; implementations filter what they need */
  rules: readonly HeuristicRule[];
}

/**
 * Port for task-state derivation. The default implementation infers from the
 * transcript; an SDD-framework adapter MAY later supply authoritative task
 * state (e.g. a feature's task list) without any core change.
 */
export interface TaskStateSource {
  deriveTaskState(input: TaskStateInput): TaskStateItem[] | Promise<TaskStateItem[]>;
}

/** `turn N` / `lines A–B` stamp for a span (provenance display). */
function turnStamp(blocks: readonly ScanBlock[], span: Span): string {
  const located = blockForSpan(blocks, span);
  if (located === null) {
    return span.startLine === span.endLine
      ? `line ${String(span.startLine)}`
      : `lines ${String(span.startLine)}–${String(span.endLine)}`;
  }
  return `turn ${String(located.turn)}`;
}

/** Drop candidates that duplicate an earlier one's excerpt at the same span. */
function dedupeCandidates(candidates: readonly ArtifactCandidate[]): ArtifactCandidate[] {
  const seen = new Set<string>();
  const unique: ArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${String(candidate.span.startLine)}:${String(candidate.span.endLine)}:${candidate.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Default TaskStateSource: transcript inference (FR-010).
 * Deterministic and explainable: within the last TASK_STATE_WINDOW user turns,
 * earlier requests are `done` and the most recent is `in progress` (it is what
 * the session is working on); task-category rule matches anywhere in the
 * session are `open` items. Every item names its turn or rule id.
 */
export const transcriptTaskStateSource: TaskStateSource = {
  deriveTaskState({ sessionId, blocks, rules }: TaskStateInput): TaskStateItem[] {
    const items: TaskStateItem[] = [];

    const userTurns = [...blocks.entries()].filter(([, block]) => block.role === 'user');
    const window = userTurns.slice(-TASK_STATE_WINDOW);
    for (const [position, [index, block]] of window.entries()) {
      const text = splitSentences(block.text)[0] ?? block.text.trim();
      if (text === '') continue;
      items.push({
        status: position === window.length - 1 ? 'in_progress' : 'done',
        text,
        source: `turn ${String(index + 1)} · user`,
      });
    }

    const taskRules = rules.filter((rule) => rule.category === 'task');
    const matches = dedupeCandidates(scanContent({ sessionId, blocks, rules: taskRules }));
    for (const candidate of matches) {
      items.push({
        status: 'open',
        text: candidate.excerpt,
        source: `${candidate.ruleId} · ${turnStamp(blocks, candidate.span)}`,
      });
    }
    return items;
  },
};

// ── Saved-artifact provenance (read-only) ─────────────────────────────────────

/** A saved artifact as the handoff sees it, recovered from its frontmatter. */
export interface SavedArtifact {
  /** workspace-relative path (`.baton/artifacts/….md`) */
  relativePath: string;
  sessionId: string;
  ruleId: string;
  category: string;
  span: Span;
  /** recomputed hash(sessionId, ruleId, span) — links matches back to files */
  candidateId: string;
  /** display title from the `# <Category> — <title>` heading, when present */
  title: string | null;
  /** full file content (feeds the ≈tokens estimate) */
  content: string;
}

/**
 * Parse one artifact file's provenance frontmatter + display title. Tolerant:
 * anything malformed yields null (mirrors the proactive engine's reader).
 */
function parseSavedArtifact(relativePath: string, content: string): SavedArtifact | null {
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fields.set(match[1], match[2].trim());
    }
  }

  const sessionId = fields.get('sessionId');
  const ruleId = fields.get('ruleId');
  const category = ruleCategorySchema.safeParse(fields.get('category'));
  const span = spanSchema.safeParse({
    startLine: Number(fields.get('startLine')),
    endLine: Number(fields.get('endLine')),
  });
  if (
    sessionId === undefined ||
    sessionId === '' ||
    ruleId === undefined ||
    ruleId === '' ||
    !category.success ||
    !span.success
  ) {
    return null;
  }

  const heading = lines.slice(end + 1).find((line) => line.startsWith('# '));
  const title = heading?.split(' — ')[1]?.trim() ?? null;

  return {
    relativePath,
    sessionId,
    ruleId,
    category: category.data,
    span: span.data,
    candidateId: candidateId(sessionId, ruleId, span.data),
    title: title === '' ? null : title,
    content,
  };
}

/**
 * Artifacts saved for a session, in stable (sorted-filename) order, recovered
 * from `.baton/artifacts/` provenance frontmatter. Read-only; a missing
 * directory means nothing was saved.
 */
export function readSavedArtifacts(workspace: string, sessionId: string): SavedArtifact[] {
  const dir = join(workspace, ARTIFACTS_RELATIVE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const artifacts: SavedArtifact[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith('.md')) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const artifact = parseSavedArtifact(join(ARTIFACTS_RELATIVE_DIR, name), content);
    if (artifact !== null && artifact.sessionId === sessionId) artifacts.push(artifact);
  }
  return artifacts;
}

/** Verification result for the `Saved artifacts (n/n verified on disk)` count. */
export interface ArtifactVerification {
  present: number;
  total: number;
}

/** Verify every referenced artifact still exists on disk (design 4a step 4). */
export function verifyArtifacts(
  workspace: string,
  artifacts: readonly SavedArtifact[],
): ArtifactVerification {
  const present = artifacts.filter((artifact) =>
    existsSync(join(workspace, artifact.relativePath)),
  ).length;
  return { present, total: artifacts.length };
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/** One numbered Key decisions line. */
export interface DecisionItem {
  text: string;
  /** linked artifact (relative path) — null ⇒ "captured here (no artifact saved)" */
  artifactPath: string | null;
  /** artifact path, or `<ruleId> · turn N` */
  source: string;
}

/** One Open questions line. */
export interface OpenQuestionItem {
  text: string;
  ruleId: string;
  span: Span;
  /** `<ruleId> · turn N` */
  source: string;
}

/** One Saved artifacts line. */
export interface ArtifactRefItem {
  relativePath: string;
  /** 1-based conversation turn of the excerpt, when locatable */
  turn: number | null;
  title: string | null;
}

export interface AssembleHandoffOptions {
  sessionId: string;
  /** session content in stable order (adapter-provided, read-only) */
  blocks: readonly ScanBlock[];
  /** ordered rule registry */
  rules: readonly HeuristicRule[];
  /** saved artifacts for the session (readSavedArtifacts) */
  artifacts: readonly SavedArtifact[];
  /** task-state port; default: transcript inference */
  taskStateSource?: TaskStateSource | undefined;
}

/** The derived draft — everything the file needs, before any write. */
export interface HandoffDraft {
  sessionId: string;
  taskState: TaskStateItem[];
  decisions: DecisionItem[];
  openQuestions: OpenQuestionItem[];
  artifactRefs: ArtifactRefItem[];
  /** the data-model sections object (shared with the future MCP surface) */
  sections: HandoffSections;
  /** ≈token estimate input: every linked artifact's content */
  artifactContents: string[];
}

/** `X done · Y in progress · Z open` summary of the task-state items. */
export function taskStateSummary(items: readonly TaskStateItem[]): string {
  const count = (status: TaskStatus): number =>
    items.filter((item) => item.status === status).length;
  return `${String(count('done'))} done · ${String(count('in_progress'))} in progress · ${String(count('open'))} open`;
}

function deriveDecisions(
  sessionId: string,
  blocks: readonly ScanBlock[],
  rules: readonly HeuristicRule[],
  artifacts: readonly SavedArtifact[],
): DecisionItem[] {
  const decisionRules = rules.filter((rule) => rule.category === 'decision');
  const matches = dedupeCandidates(scanContent({ sessionId, blocks, rules: decisionRules }));
  const byCandidateId = new Map(artifacts.map((artifact) => [artifact.candidateId, artifact]));

  const ordered: { startLine: number; item: DecisionItem }[] = [];
  const linkedPaths = new Set<string>();

  // Decision-category rule matches — linked when a saved artifact's provenance
  // recomputes to the same candidate id, otherwise captured here.
  for (const candidate of matches) {
    const artifact = byCandidateId.get(candidate.id);
    if (artifact !== undefined) linkedPaths.add(artifact.relativePath);
    ordered.push({
      startLine: candidate.span.startLine,
      item: {
        text: candidate.excerpt,
        artifactPath: artifact?.relativePath ?? null,
        source:
          artifact?.relativePath ??
          `${candidate.ruleId} · ${turnStamp(blocks, candidate.span)}`,
      },
    });
  }

  // Remaining saved artifacts (any category) are decisions the session chose to
  // keep — design 4b lists constraint/result artifacts under Key decisions too.
  for (const artifact of artifacts) {
    if (linkedPaths.has(artifact.relativePath)) continue;
    ordered.push({
      startLine: artifact.span.startLine,
      item: {
        text: artifact.title ?? artifact.relativePath,
        artifactPath: artifact.relativePath,
        source: artifact.relativePath,
      },
    });
  }

  ordered.sort(
    (a, b) => a.startLine - b.startLine || a.item.text.localeCompare(b.item.text),
  );
  return ordered.map((entry) => entry.item);
}

function deriveOpenQuestions(
  sessionId: string,
  blocks: readonly ScanBlock[],
  rules: readonly HeuristicRule[],
): OpenQuestionItem[] {
  const questionRules = rules.filter((rule) => rule.category === 'question');
  const matches = dedupeCandidates(scanContent({ sessionId, blocks, rules: questionRules }));
  return matches.map((candidate) => ({
    text: candidate.excerpt,
    ruleId: candidate.ruleId,
    span: candidate.span,
    source: `${candidate.ruleId} · ${turnStamp(blocks, candidate.span)}`,
  }));
}

/**
 * Assemble the handoff draft from session content + saved artifacts. Pure with
 * respect to its inputs: same content, registry, artifacts, and port ⇒
 * identical draft. Writes nothing.
 */
export async function assembleHandoff(options: AssembleHandoffOptions): Promise<HandoffDraft> {
  const { sessionId, blocks, rules, artifacts } = options;
  const port = options.taskStateSource ?? transcriptTaskStateSource;

  const taskState = await port.deriveTaskState({ sessionId, blocks, rules });
  const decisions = deriveDecisions(sessionId, blocks, rules, artifacts);
  const openQuestions = deriveOpenQuestions(sessionId, blocks, rules);
  const artifactRefs: ArtifactRefItem[] = artifacts.map((artifact) => ({
    relativePath: artifact.relativePath,
    turn: blockForSpan(blocks, artifact.span)?.turn ?? null,
    title: artifact.title,
  }));

  const sections = handoffSectionsSchema.parse({
    decisions: decisions.map((item) => ({ text: item.text, source: item.source })),
    taskState: {
      summary: taskStateSummary(taskState),
      sources: taskState.map((item) => item.source),
    },
    openQuestions: openQuestions.map((item) => ({
      text: item.text,
      ruleId: item.ruleId,
      span: item.span,
    })),
    artifactRefs: artifacts.map((artifact) => artifact.relativePath),
  });

  return {
    sessionId,
    taskState,
    decisions,
    openQuestions,
    artifactRefs,
    sections,
    artifactContents: artifacts.map((artifact) => artifact.content),
  };
}

// ── Rendering (design 4b, verbatim layout) ────────────────────────────────────

/** Everything the header meta needs — the clock is injected, never read here. */
export interface HandoffMeta {
  /** absolute workspace path (Resume step 1) */
  workspacePath: string;
  /** injected write timestamp (ISO) */
  writtenAtIso: string;
  /** current reading, or null when usage is unknown (FR-011: stated, not faked) */
  reading: UsageReading | null;
  /** zone of the reading, or null when unknown */
  zone: ZoneName | null;
  /** conversation turns scanned (content blocks) */
  turns: number;
  /** artifacts-on-disk verification (design 4a step 4) */
  verification: ArtifactVerification;
}

/** Canonical tokens display `94.2k/200k` (design formula). */
function tokensDisplay(tokensUsed: number, contextWindow: number): string {
  return `${(tokensUsed / 1000).toFixed(1)}k/${String(Math.round(contextWindow / 1000))}k`;
}

/** `2026-07-02 18:50` display form of an ISO timestamp (UTC). */
function displayTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** `≈ 2k tokens` — chars/4 estimate rounded to whole k, floor 1k, visibly ≈. */
function approxTokensLabel(text: string): string {
  const tokens = estimateTokens(text);
  return `≈ ${String(Math.max(1, Math.round(tokens / 1000)))}k tokens`;
}

const NONE_LINE = '- none';

/**
 * Render the handoff draft to the design 4b Markdown file. Pure function of
 * (draft, meta) — deterministic, byte for byte.
 */
export function renderHandoffMarkdown(draft: HandoffDraft, meta: HandoffMeta): string {
  const { reading, zone } = meta;

  const usagePart =
    reading !== null && zone !== null
      ? `at ${String(Math.round(reading.pct))}% (${zone}${reading.precision === 'estimated' ? ', estimated' : ''}) · ${tokensDisplay(reading.tokensUsed, reading.contextWindow)}`
      : 'usage unknown';
  const metaLine = `- written ${displayTimestamp(meta.writtenAtIso)} · ${usagePart} · ${String(meta.turns)} turns`;

  const taskLines =
    draft.taskState.length === 0
      ? [NONE_LINE]
      : draft.taskState.map(
          (item) => `- ${TASK_GLYPHS[item.status]} — ${item.text} [source: ${item.source}]`,
        );

  const decisionLines =
    draft.decisions.length === 0
      ? [NONE_LINE]
      : draft.decisions.map((item, index) => {
          const tail =
            item.artifactPath !== null
              ? `→ ${item.artifactPath}`
              : '— captured here (no artifact saved)';
          return `${String(index + 1)}. ${item.text} ${tail} [source: ${item.source}]`;
        });

  const artifactLines =
    draft.artifactRefs.length === 0
      ? [NONE_LINE]
      : draft.artifactRefs.map((ref) => {
          const parts = [`- ${ref.relativePath}`];
          if (ref.turn !== null) parts.push(`turn ${String(ref.turn)}`);
          if (ref.title !== null) parts.push(ref.title);
          return parts.join(' · ');
        });

  const questionLines =
    draft.openQuestions.length === 0
      ? [NONE_LINE]
      : draft.openQuestions.map((item) => `- ${item.text} [source: ${item.source}]`);

  const inProgress = [...draft.taskState].reverse().find((item) => item.status === 'in_progress');

  const body = (approxLine: string): string =>
    [
      `# Handoff — ${basename(meta.workspacePath)} · session ${draft.sessionId.slice(0, 8)}`,
      '',
      metaLine,
      approxLine,
      '',
      '## Task state',
      '',
      ...taskLines,
      '',
      '## Key decisions',
      '',
      ...decisionLines,
      '',
      `## Saved artifacts (${String(meta.verification.present)}/${String(meta.verification.total)} verified on disk)`,
      '',
      ...artifactLines,
      '',
      '## Open questions',
      '',
      ...questionLines,
      '',
      '## Resume',
      '',
      `1. start a fresh session in ${meta.workspacePath}`,
      '2. read this file · pull artifacts only as needed',
      `3. continue at: ${inProgress?.text ?? '—'}`,
      '',
    ].join('\n');

  // The ≈tokens note estimates reading THIS file plus every linked artifact —
  // computed over the rendered body itself (with the note blanked) so the
  // figure stays deterministic and honest (visibly ≈, FR-013 spirit).
  const approx = approxTokensLabel(body('') + draft.artifactContents.join('\n'));
  const producedTail =
    reading !== null
      ? ` — not the ${(reading.tokensUsed / 1000).toFixed(1)}k that produced it`
      : '';
  return body(`- reading this + linked artifacts ${approx}${producedTail}`);
}

// ── Paths + the single write ──────────────────────────────────────────────────

/** Workspace-relative default path: `.baton/handoff/<ts>-handoff.md`. */
export function handoffRelativePath(writtenAtIso: string): string {
  return join(HANDOFF_RELATIVE_DIR, `${fileTimestamp(writtenAtIso)}-handoff.md`);
}

/**
 * The single handoff write (FR-010): creates the parent directory and writes
 * the file. Only ever invoked on explicit user request — never automatic.
 */
export function writeHandoffFile(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

// ── `baton context handoff --json` contract schema ────────────────────────────

/** Contract shape of `baton context handoff --json` (contracts/cli-interface.md). */
export const handoffReportSchema = z.object({
  path: z.string(),
  sessionId: z.string(),
  artifactCount: z.number().int().min(0),
});
export type HandoffReport = z.infer<typeof handoffReportSchema>;
