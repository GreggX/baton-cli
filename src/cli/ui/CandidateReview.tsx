// T045 — Ink CandidateReview (design 3a review loop, FR-009).
//
// One candidate at a time: progress dots (✓ accepted · ✕ rejected · ◉ current
// · ○ remaining), the rule pill with `matched "<phrase>"` and `turn N · role`,
// the excerpt with the matched span underlined, and `on accept → <path>`.
// Keys: `[y] accept · [n] reject · [u] undo`. When every candidate is decided
// the completion box renders: `⏺ REVIEW COMPLETE — 2 accepted · 3 rejected`,
// the wrote line (or `no files written — nothing was accepted`), and one
// `+ <path>` line per written file. Purely presentational — the save command
// owns all writes; this component only collects accept/reject decisions.
import { Box, Text, useInput } from 'ink';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ArtifactCandidate, RuleCategory } from '../../core/heuristics/types.js';
import { FAINT_COLOR, MUTED_COLOR, TEXT_COLOR, ZONE_COLORS } from './format.js';

/** Verbatim design 3a copy. */
export const NO_FILES_LINE = 'no files written — nothing was accepted';
export const REVIEW_KEYS_LINE = '[y] accept · [n] reject · [u] undo';

/** `wrote 2 files — rejected candidates were not written` (design 3a). */
export function wroteLine(acceptedCount: number): string {
  if (acceptedCount === 0) return NO_FILES_LINE;
  const files = acceptedCount === 1 ? 'file' : 'files';
  return `wrote ${String(acceptedCount)} ${files} — rejected candidates were not written`;
}

/** One reviewable candidate with everything the 3a card displays. */
export interface ReviewItem {
  candidate: ArtifactCandidate;
  category: RuleCategory;
  /** category display color (rule pill) */
  color: string;
  /** lowercased matched phrase (`matched "we decided"`), or null */
  matchedPhrase: string | null;
  /** `turn 12 · assistant` */
  location: string;
  /** excerpt split around the matched span (match empty ⇒ no underline) */
  pre: string;
  match: string;
  post: string;
  /** workspace-relative path written on accept */
  targetPath: string;
}

type Decision = 'pending' | 'accepted' | 'rejected';

export interface CandidateReviewProps {
  /** `⏺ scanned 34 turns · 4 rules · 5 candidates · fingerprint a3f2c9` */
  header: string;
  items: readonly ReviewItem[];
  /** paths actually written, once the save command persisted them; null before */
  written: readonly string[] | null;
  /** fires exactly once, when the last candidate is decided */
  onComplete: (acceptedIds: string[]) => void;
}

const DOT_GLYPHS: Record<Decision | 'current', string> = {
  accepted: '✓',
  rejected: '✕',
  current: '◉',
  pending: '○',
};
const DOT_COLORS: Record<Decision | 'current', string> = {
  accepted: ZONE_COLORS.green,
  rejected: MUTED_COLOR,
  current: TEXT_COLOR,
  pending: FAINT_COLOR,
};

export function CandidateReview(props: CandidateReviewProps): JSX.Element {
  const { header, items, written, onComplete } = props;
  const [decisions, setDecisions] = useState<Decision[]>(() =>
    items.map(() => 'pending'),
  );
  const completedRef = useRef(false);

  const currentIndex = decisions.indexOf('pending');
  const done = currentIndex === -1;
  const acceptedCount = decisions.filter((d) => d === 'accepted').length;
  const rejectedCount = decisions.filter((d) => d === 'rejected').length;

  useEffect(() => {
    if (!done || completedRef.current) return;
    completedRef.current = true;
    onComplete(
      items
        .filter((_item, index) => decisions[index] === 'accepted')
        .map((item) => item.candidate.id),
    );
  }, [done, decisions, items, onComplete]);

  useInput(
    (input) => {
      if (input === 'y' || input === 'n') {
        setDecisions((previous) => {
          const next = [...previous];
          const index = next.indexOf('pending');
          if (index !== -1) next[index] = input === 'y' ? 'accepted' : 'rejected';
          return next;
        });
      }
      if (input === 'u') {
        setDecisions((previous) => {
          const next = [...previous];
          const pending = next.indexOf('pending');
          const back = (pending === -1 ? next.length : pending) - 1;
          if (back >= 0) next[back] = 'pending';
          return next;
        });
      }
    },
    { isActive: !done },
  );

  const current = done ? null : items[currentIndex];

  return (
    <Box flexDirection="column">
      <Text color={MUTED_COLOR}>{header}</Text>

      {/* progress dots: ✓ accepted · ✕ rejected · ◉ current · ○ remaining */}
      <Box marginTop={1}>
        <Text>
          {decisions.map((decision, index) => {
            const kind = decision === 'pending' && index === currentIndex ? 'current' : decision;
            return (
              <Text key={items[index]?.candidate.id ?? String(index)} color={DOT_COLORS[kind]}>
                {`${DOT_GLYPHS[kind]} `}
              </Text>
            );
          })}
        </Text>
        <Text color={MUTED_COLOR}>
          {done
            ? ' review complete'
            : ` candidate ${String(currentIndex + 1)} of ${String(items.length)}`}
        </Text>
      </Box>

      {current !== undefined && current !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor={FAINT_COLOR} paddingX={1}>
          <Text>
            <Text color={current.color} bold>
              {current.candidate.ruleId}
            </Text>
            {current.matchedPhrase !== null ? (
              <Text color={MUTED_COLOR}>{` matched "${current.matchedPhrase}"`}</Text>
            ) : null}
            <Text color={MUTED_COLOR}>{`  ${current.location}`}</Text>
          </Text>
          <Text>
            {current.pre}
            <Text color={current.color} bold underline>
              {current.match}
            </Text>
            {current.post}
          </Text>
          <Text color={MUTED_COLOR}>
            {'on accept → '}
            <Text color={TEXT_COLOR}>{current.targetPath}</Text>
          </Text>
          <Text color={MUTED_COLOR}>{REVIEW_KEYS_LINE}</Text>
        </Box>
      ) : null}

      {done ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={ZONE_COLORS.green}
          paddingX={1}
        >
          <Text color={ZONE_COLORS.green} bold>
            {`⏺ REVIEW COMPLETE — ${String(acceptedCount)} accepted · ${String(rejectedCount)} rejected`}
          </Text>
          <Text color={MUTED_COLOR}>{wroteLine(acceptedCount)}</Text>
          {(written ?? []).map((path) => (
            <Text key={path} color={ZONE_COLORS.green}>{`+ ${path}`}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export default CandidateReview;
