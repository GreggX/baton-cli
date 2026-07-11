// T036 — Ink TransitionBanner (design 2a arc + 2b toast) + pending advisory list.
// Title `▲ ENTERED ORANGE` / `● BACK IN GREEN`, subtitle names every threshold
// crossed (`crossed 40% & 60% · now 68%`) or the drop (`compaction 78% → 30%`),
// footer is the verbatim advisory line. Keys: `d` dismisses (persisted, re-arms at
// the next boundary — FR-014), `enter` acts on the first pending recommendation.
// Recovery renders as a quiet stamp, not an alert; a dismissed zone stays quiet
// (`— still orange, no repeat`).
import { Box, Text, useInput } from 'ink';
import type { JSX } from 'react';
import type { Recommendation, ZoneTransition } from '../../core/monitor/types.js';
import { FAINT_COLOR, MUTED_COLOR, ZONE_COLORS, ZONE_GLYPHS } from './format.js';

/** Verbatim banner footer (design-notes "Transition banner"). */
export const BANNER_FOOTER =
  'advisory — nothing runs by itself · d dismiss · re-arms at the next boundary';

export interface TransitionBannerModel {
  transition: ZoneTransition;
  /** `crossed 40% & 60% · now 68%` or `compaction 78% → 30%` (core-derived) */
  subtitle: string;
}

/** Banner title: escalation `▲ ENTERED ORANGE`, de-escalation `● BACK IN GREEN`. */
export function bannerTitle(transition: ZoneTransition): string {
  const glyph = ZONE_GLYPHS[transition.to];
  const zone = transition.to.toUpperCase();
  return transition.direction === 'escalation'
    ? `${glyph} ENTERED ${zone}`
    : `${glyph} BACK IN ${zone}`;
}

export interface TransitionBannerProps {
  /** active toast; null when quieted (auto ~6s) or dismissed */
  banner: TransitionBannerModel | null;
  /** pending advisories (dismiss with `d`, act with `enter`) */
  pending: readonly Recommendation[];
  /** quiet recovery stamp (`● BACK IN GREEN · … · notices re-armed`), not an alert */
  recovery: string | null;
  /** anti-nag note shown after a dismissal while the zone is unchanged */
  suppressedNote: string | null;
  onDismiss: () => void;
  onAct: () => void;
}

export function TransitionBanner(props: TransitionBannerProps): JSX.Element | null {
  const { banner, pending, recovery, suppressedNote, onDismiss, onAct } = props;
  const actionable = banner !== null || pending.length > 0;

  useInput(
    (input, key) => {
      if (input === 'd') onDismiss();
      if (key.return) onAct();
    },
    { isActive: actionable },
  );

  if (!actionable && recovery === null && suppressedNote === null) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {recovery !== null ? <Text color={ZONE_COLORS.green}>{recovery}</Text> : null}
      {banner !== null ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={ZONE_COLORS[banner.transition.to]}
          paddingX={1}
        >
          <Text color={ZONE_COLORS[banner.transition.to]} bold>
            {bannerTitle(banner.transition)}
          </Text>
          <Text>{banner.subtitle}</Text>
          <Text color={MUTED_COLOR}>{BANNER_FOOTER}</Text>
        </Box>
      ) : null}
      {suppressedNote !== null ? <Text color={MUTED_COLOR}>{suppressedNote}</Text> : null}
      {pending.length > 0 ? (
        <Box flexDirection="column">
          <Text color={MUTED_COLOR}>PENDING · d dismiss · enter act</Text>
          {pending.map((recommendation) => (
            <Text key={recommendation.id}>
              <Text color={FAINT_COLOR}>{`${recommendation.kind} `}</Text>
              <Text>{recommendation.guidance}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export default TransitionBanner;
