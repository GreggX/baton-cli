// T044 — Artifact store: accepted candidates → workspace Markdown files (FR-009).
//
// Writes `.baton/artifacts/<timestamp>-<ruleId>-<slug>.md` with YAML provenance
// frontmatter (sessionId, ruleId, category, span, savedAt — data-model Artifact)
// followed by the design 3d body: `# <Category> — <slug title>` header, the
// session/turn/timestamp line, `- rule: <id> (matched "…")`,
// `- saved: accepted by user before compaction`, and the verbatim excerpt as a
// `>` quote — plain markdown, readable without baton.
//
// Guarantees (SC-004): accepted-only — a rejected candidate anywhere in the
// batch aborts before any file is written; everything is rendered and validated
// up front, so there are no partial writes. `savedAt` is injected by the caller
// (the save command's single wall-clock read) — nothing here consults a clock.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Artifact, ArtifactCandidate, HeuristicRule } from '../heuristics/types.js';
import { artifactSchema } from '../heuristics/types.js';

/** Contract shape of `baton context save --json` (contracts/cli-interface.md). */
export const saveReportSchema = z.object({
  saved: z.array(
    z.object({
      candidateId: z.string(),
      /** workspace-relative artifact path */
      path: z.string(),
    }),
  ),
});
export type SaveReport = z.infer<typeof saveReportSchema>;

/** Workspace-relative directory holding accepted artifacts. */
export const ARTIFACTS_RELATIVE_DIR = join('.baton', 'artifacts');

/** Verbatim design 3d provenance line — why the file exists. */
export const SAVED_LINE = 'saved: accepted by user before compaction';

/** One accepted candidate plus the display context its file needs. */
export interface PlannedArtifact {
  candidate: ArtifactCandidate;
  rule: HeuristicRule;
  /** lowercased matched phrase for `- rule: <id> (matched "…")`, or null */
  matchedPhrase: string | null;
  /** 1-based conversation turn of the excerpt, when locatable */
  turn: number | null;
  /** ISO timestamp of the turn, when the session data carries one */
  turnTimestamp: string | null;
}

// ── Deterministic naming ──────────────────────────────────────────────────────

const SLUG_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'in',
  'into', 'is', 'it', 'its', 'keep', 'keeping', 'of', 'on', 'or', 'our', 'so',
  'that', 'the', 'these', 'this', 'those', 'to', 'up', 'use', 'using', 'was',
  'we', 'were', 'with',
]);

/** Significant words of an excerpt (matched phrase and stop words removed). */
function significantWords(excerpt: string, matchedPhrase: string | null): string[] {
  let text = excerpt.toLowerCase();
  if (matchedPhrase !== null && matchedPhrase !== '') {
    text = text.replace(matchedPhrase.toLowerCase(), ' ');
  }
  return text
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !SLUG_STOP_WORDS.has(word));
}

/** Deterministic slug: first two significant excerpt words (`adapter-approach`). */
export function artifactSlug(excerpt: string, matchedPhrase: string | null): string {
  const words = significantWords(excerpt, matchedPhrase).slice(0, 2);
  return words.length > 0 ? words.join('-') : 'excerpt';
}

/** Deterministic title fragment: first four significant excerpt words. */
export function artifactTitle(excerpt: string, matchedPhrase: string | null): string {
  const words = significantWords(excerpt, matchedPhrase).slice(0, 4);
  return words.length > 0 ? words.join(' ') : 'excerpt';
}

/** `YYYYMMDD-HHMMSS` (UTC) stamp for artifact file names. */
export function fileTimestamp(savedAtIso: string): string {
  return savedAtIso.slice(0, 19).replaceAll('-', '').replaceAll(':', '').replace('T', '-');
}

/** Workspace-relative artifact path: `.baton/artifacts/<ts>-<ruleId>-<slug>.md`. */
export function artifactRelativePath(planned: PlannedArtifact, savedAtIso: string): string {
  const slug = artifactSlug(planned.candidate.excerpt, planned.matchedPhrase);
  return join(
    ARTIFACTS_RELATIVE_DIR,
    `${fileTimestamp(savedAtIso)}-${planned.rule.id}-${slug}.md`,
  );
}

/**
 * Paths for a whole batch, in order, deduplicated deterministically: a
 * colliding name gains a `-2`, `-3`, … suffix.
 */
export function planArtifactPaths(
  planned: readonly PlannedArtifact[],
  savedAtIso: string,
): string[] {
  const used = new Set<string>();
  return planned.map((entry) => {
    const base = artifactRelativePath(entry, savedAtIso);
    let path = base;
    for (let n = 2; used.has(path); n += 1) {
      path = base.replace(/\.md$/, `-${String(n)}.md`);
    }
    used.add(path);
    return path;
  });
}

// ── Rendering (YAML frontmatter + design 3d body) ─────────────────────────────

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `2026-07-02 18:50` display form of an ISO timestamp (UTC), or null. */
function displayTimestamp(iso: string | null): string | null {
  if (iso === null) return null;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Full artifact file content: provenance frontmatter, then the 3d body. */
export function renderArtifactMarkdown(planned: PlannedArtifact, savedAtIso: string): string {
  const { candidate, rule, matchedPhrase, turn, turnTimestamp } = planned;

  const sessionParts = [`session: ${candidate.sessionId.slice(0, 8)}`];
  if (turn !== null) sessionParts.push(`turn ${String(turn)}`);
  const shownTime = displayTimestamp(turnTimestamp);
  if (shownTime !== null) sessionParts.push(shownTime);

  const ruleLine =
    matchedPhrase === null
      ? `- rule: ${rule.id}`
      : `- rule: ${rule.id} (matched "${matchedPhrase}")`;

  const quote = candidate.excerpt
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  return [
    '---',
    `sessionId: ${candidate.sessionId}`,
    `ruleId: ${rule.id}`,
    `category: ${rule.category}`,
    'span:',
    `  startLine: ${String(candidate.span.startLine)}`,
    `  endLine: ${String(candidate.span.endLine)}`,
    `savedAt: ${savedAtIso}`,
    '---',
    '',
    `# ${capitalize(rule.category)} — ${artifactTitle(candidate.excerpt, matchedPhrase)}`,
    '',
    `- ${sessionParts.join(' · ')}`,
    ruleLine,
    `- ${SAVED_LINE}`,
    '',
    quote,
    '',
  ].join('\n');
}

// ── Persistence (accepted-only, no partial writes) ────────────────────────────

/**
 * Persist a batch of accepted candidates as artifacts under the workspace.
 * Everything is validated and rendered BEFORE the first write: any rejected
 * candidate in the batch throws and nothing lands on disk (FR-009, SC-004).
 * Returns the written artifacts with workspace-relative paths.
 */
export function saveArtifacts(
  workspace: string,
  planned: readonly PlannedArtifact[],
  savedAt: Date | string,
): Artifact[] {
  const savedAtIso = typeof savedAt === 'string' ? savedAt : savedAt.toISOString();

  // Validate + render everything first — no partial writes.
  for (const entry of planned) {
    if (entry.candidate.status === 'rejected') {
      throw new Error(
        `refusing to save rejected candidate ${entry.candidate.id} — rejected candidates are never written (FR-009)`,
      );
    }
  }
  const paths = planArtifactPaths(planned, savedAtIso);
  const rendered = planned.map((entry, index) => ({
    content: renderArtifactMarkdown(entry, savedAtIso),
    artifact: artifactSchema.parse({
      path: paths[index],
      candidateId: entry.candidate.id,
      frontmatter: {
        sessionId: entry.candidate.sessionId,
        ruleId: entry.rule.id,
        category: entry.rule.category,
        span: entry.candidate.span,
        savedAt: savedAtIso,
      },
    }),
  }));

  for (const { content, artifact } of rendered) {
    const absolute = join(workspace, artifact.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return rendered.map((entry) => entry.artifact);
}
