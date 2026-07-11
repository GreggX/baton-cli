// T027 — Ink TrafficLight component (US1).
// The zone signal: glyph + big percentage + zone pill, precision label, data age.
// Shape is the primary channel (colorblind-safe): the zone is always readable from
// the glyph alone. Unknown state renders the design 5a treatment — never a live
// zone without data (FR-011). Estimated readings are visibly labeled (FR-013).
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import type { ZoneName } from '../../core/monitor/types.js';
import {
  MUTED_COLOR,
  UNKNOWN_COLOR,
  UNKNOWN_GLYPH,
  ZONE_COLORS,
  ZONE_GLYPHS,
  formatAge,
} from './format.js';

export interface TrafficLightProps {
  /** null → unknown state (no zone is ever fabricated). */
  zone: ZoneName | null;
  /** null → unknown state. */
  pct: number | null;
  precision?: 'exact' | 'estimated' | undefined;
  /** seconds since the reading; null hides the age stamp. */
  dataAgeSeconds?: number | null | undefined;
  /** dim the whole signal (STALE demoted last-good display, design 5a). */
  demoted?: boolean | undefined;
}

export function TrafficLight(props: TrafficLightProps): JSX.Element {
  const { zone, pct, precision, dataAgeSeconds, demoted = false } = props;

  if (zone === null || pct === null) {
    return (
      <Box gap={1}>
        <Text color={UNKNOWN_COLOR}>{`${UNKNOWN_GLYPH} --%`}</Text>
        <Text color={UNKNOWN_COLOR} bold>
          UNKNOWN
        </Text>
      </Box>
    );
  }

  const color = ZONE_COLORS[zone];
  return (
    <Box gap={1}>
      <Text color={color} dimColor={demoted}>
        {ZONE_GLYPHS[zone]}
      </Text>
      <Text bold dimColor={demoted}>{`${String(Math.round(pct))}%`}</Text>
      {demoted ? (
        <Text color={color} bold dimColor>
          {` ${zone.toUpperCase()} `}
        </Text>
      ) : (
        <Text backgroundColor={color} color="#1a1b26" bold>
          {` ${zone.toUpperCase()} `}
        </Text>
      )}
      {precision === 'estimated' ? (
        <Text color={MUTED_COLOR} italic>
          estimated
        </Text>
      ) : null}
      {typeof dataAgeSeconds === 'number' ? (
        <Text color={MUTED_COLOR}>{`updated ${formatAge(dataAgeSeconds)} ago`}</Text>
      ) : null}
    </Box>
  );
}

export default TrafficLight;
