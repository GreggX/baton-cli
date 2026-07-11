// T049 — Proactive save-suggestion engine (US3, FR-015 + FR-006/FR-014).
//
// While the session is in orange or red, an automatic READ-ONLY scan runs over
// the session content (on zone entry and on every refresh) and emits one
// `save_candidate` recommendation per offerable candidate — each with a
// mandatory `rule_match` trigger {ruleId, candidateId} and guidance naming the
// rule that fired (FR-006). Candidates the user already dismissed (persisted in
// MonitorState) or already saved (recomputed from artifact frontmatter
// provenance) are NEVER re-offered; candidate dismissals are sticky and do not
// re-arm on zone changes (data-model: "a candidate already saved or dismissed
// is never re-offered"). New candidates surfaced by later in-zone activity are
// offered as they appear.
//
// Determinism: `proactiveScan` is a pure function of its inputs — no clock, no
// randomness, no IO. The only IO here is `savedCandidateIds`, a read-only walk
// of `.baton/artifacts/` frontmatter; the scan path writes nothing (FR-007).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_RELATIVE_DIR } from '../artifacts/store.js';
import { recommendationId } from '../monitor/recommendations.js';
import type { ScanBlock } from '../monitor/session-source.js';
import type { MonitorState, Recommendation, Trigger, ZoneName } from '../monitor/types.js';
import { candidateId, findMatch, scanContent } from './scanner.js';
import type { ArtifactCandidate, HeuristicRule, Span } from './types.js';

// ── Zone gating (FR-015) ──────────────────────────────────────────────────────

/** Zones in which the automatic save-candidate scan runs. */
export const PROACTIVE_ZONES: readonly ZoneName[] = Object.freeze(['orange', 'red']);

/** True when the zone warrants proactive save suggestions (orange/red). */
export function isProactiveZone(zone: ZoneName): boolean {
  return PROACTIVE_ZONES.includes(zone);
}

// ── Per-candidate recommendations (FR-006) ────────────────────────────────────

/**
 * Guidance for one save suggestion — names the rule that fired, the matched
 * phrase, and the transcript location, so the advice is fully explainable.
 */
export function saveCandidateGuidance(
  candidate: ArtifactCandidate,
  rule: HeuristicRule,
): string {
  const match = findMatch(rule, candidate.excerpt);
  const matched = match === null ? rule.description : `"${match.phrase.toLowerCase()}"`;
  const lines =
    candidate.span.startLine === candidate.span.endLine
      ? `line ${String(candidate.span.startLine)}`
      : `lines ${String(candidate.span.startLine)}–${String(candidate.span.endLine)}`;
  return `Save suggestion — rule ${rule.id} matched ${matched} at ${lines}. Accept with \`baton context save ${candidate.id}\`; a dismissed candidate is never re-offered.`;
}

/** Build the pending per-candidate advisory (deterministic id, FR-006 trigger). */
export function saveCandidateRecommendation(
  candidate: ArtifactCandidate,
  rule: HeuristicRule,
): Recommendation {
  const trigger: Trigger = {
    kind: 'rule_match',
    ruleId: rule.id,
    candidateId: candidate.id,
  };
  return {
    id: recommendationId(candidate.sessionId, 'save_candidate', trigger),
    kind: 'save_candidate',
    trigger,
    guidance: saveCandidateGuidance(candidate, rule),
    state: 'pending',
  };
}

// ── Sticky per-candidate dismissal bookkeeping (FR-014/FR-015) ────────────────

/**
 * Record a candidate dismissal. Sticky: unlike zone advisories, a dismissed
 * candidate never re-arms — it is never offered again in any zone.
 */
export function dismissCandidate(
  state: MonitorState,
  candidateIdValue: string,
  dismissedAt: string,
): MonitorState {
  const existing = state.dismissedCandidates ?? [];
  if (existing.some((record) => record.candidateId === candidateIdValue)) return state;
  return {
    ...state,
    dismissedCandidates: [...existing, { candidateId: candidateIdValue, dismissedAt }],
  };
}

/** True when the candidate was dismissed (in any zone — dismissals are sticky). */
export function isCandidateDismissed(state: MonitorState, candidateIdValue: string): boolean {
  return (state.dismissedCandidates ?? []).some(
    (record) => record.candidateId === candidateIdValue,
  );
}

// ── Saved-candidate provenance (artifact frontmatter) ─────────────────────────

/** Frontmatter fields needed to recompute a saved artifact's candidate id. */
interface SavedProvenance {
  sessionId: string;
  ruleId: string;
  span: Span;
}

/**
 * Parse the YAML provenance frontmatter the artifact store writes
 * (sessionId/ruleId/span/…). Tolerant: anything malformed yields null.
 */
function parseArtifactProvenance(content: string): SavedProvenance | null {
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
  const startLine = Number(fields.get('startLine'));
  const endLine = Number(fields.get('endLine'));
  if (
    sessionId === undefined ||
    sessionId === '' ||
    ruleId === undefined ||
    ruleId === '' ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine)
  ) {
    return null;
  }
  return { sessionId, ruleId, span: { startLine, endLine } };
}

/**
 * Candidate ids already persisted as artifacts for a session, recomputed from
 * the provenance frontmatter under `.baton/artifacts/` — the stable derivation
 * hash(sessionId, ruleId, span) makes saved candidates recognizable across
 * rescans. Read-only; a missing directory means nothing was saved.
 */
export function savedCandidateIds(workspace: string, sessionId: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(workspace, ARTIFACTS_RELATIVE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return ids; // no artifacts directory yet: nothing saved
  }
  for (const name of [...names].sort()) {
    if (!name.endsWith('.md')) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const provenance = parseArtifactProvenance(content);
    if (provenance === null || provenance.sessionId !== sessionId) continue;
    ids.add(candidateId(sessionId, provenance.ruleId, provenance.span));
  }
  return ids;
}

// ── The proactive scan (pure) ─────────────────────────────────────────────────

export interface ProactiveScanOptions {
  /** owning session — candidate ids derive from it */
  sessionId: string;
  /** current zone; the scan only runs in orange/red (FR-015) */
  zone: ZoneName;
  /** session content in stable order (adapter-provided, read-only) */
  blocks: readonly ScanBlock[];
  /** ordered rule registry */
  rules: readonly HeuristicRule[];
  /** persisted bookkeeping — per-candidate dismissals are honored (FR-014) */
  state: MonitorState;
  /** candidate ids already saved as artifacts (frontmatter provenance) */
  savedCandidateIds?: ReadonlySet<string> | undefined;
  /** candidate ids already offered in this watch run (pending — not re-emitted) */
  offeredCandidateIds?: ReadonlySet<string> | undefined;
}

export interface ProactiveScanResult {
  /** true when the zone warranted a scan (orange/red) */
  scanned: boolean;
  /** every offerable candidate: matched, not saved, not dismissed */
  candidates: ArtifactCandidate[];
  /** NEW offers only — offerable candidates not yet offered this run */
  recommendations: Recommendation[];
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Run the automatic save-candidate scan for one refresh. Pure and
 * deterministic: same content, registry, and bookkeeping ⇒ identical result.
 * Nothing is written — emitting and persisting are the caller's concern.
 */
export function proactiveScan(options: ProactiveScanOptions): ProactiveScanResult {
  if (!isProactiveZone(options.zone)) {
    return { scanned: false, candidates: [], recommendations: [] };
  }

  const saved = options.savedCandidateIds ?? EMPTY_SET;
  const offered = options.offeredCandidateIds ?? EMPTY_SET;

  const all = scanContent({
    sessionId: options.sessionId,
    blocks: options.blocks,
    rules: options.rules,
  });
  // Already saved or already dismissed ⇒ never re-offered (FR-014/FR-015).
  const candidates = all.filter(
    (candidate) =>
      !saved.has(candidate.id) && !isCandidateDismissed(options.state, candidate.id),
  );

  const ruleIndex = new Map(options.rules.map((rule) => [rule.id, rule]));
  const recommendations = candidates
    .filter((candidate) => !offered.has(candidate.id))
    .flatMap((candidate) => {
      const rule = ruleIndex.get(candidate.ruleId);
      return rule === undefined ? [] : [saveCandidateRecommendation(candidate, rule)];
    });

  return { scanned: true, candidates, recommendations };
}

// ── Aggregated pending display (watch TTY) ────────────────────────────────────

/**
 * Aggregated pending line for the watch pane — presentation MAY aggregate,
 * the model stays per-candidate (data-model): e.g.
 * `3 save suggestions pending — [a] review [d] dismiss`.
 */
export function saveSuggestionsPendingLine(count: number): string {
  const noun = count === 1 ? 'save suggestion' : 'save suggestions';
  return `${String(count)} ${noun} pending — [a] review [d] dismiss`;
}
