// T013 — Zone classification (data-model.md Zone).
// Derived, not stored: green [0,yellow) | yellow [yellow,orange) | orange [orange,red)
// | red [red,100]. Pure function of (pct, thresholds) — deterministic and explainable.
import type { ZoneThresholds } from '../config/schema.js';
import type { ZoneName } from './types.js';

/** Zone escalation order, least to most saturated. */
export const ZONE_ORDER: readonly ZoneName[] = ['green', 'yellow', 'orange', 'red'];

/**
 * Canonical guidance table — one static guidance string per zone.
 * Copy is verbatim from design-notes.md "Zone guidance copy" (FR-005/T013);
 * green is the recovery/de-escalation message.
 */
export const ZONE_GUIDANCE: Readonly<Record<ZoneName, string>> = Object.freeze({
  green: 'Runway restored — keep prompting freely.',
  yellow: 'Favor targeted retrieval over pasting whole documents.',
  orange: 'Review artifact candidates, then compact the conversation.',
  red: 'Start a fresh session from a handoff summary.',
});

/**
 * Classify a usage percentage into its traffic-light zone.
 * Boundaries are inclusive at the lower edge of each zone:
 * pct < yellow -> green; [yellow,orange) -> yellow; [orange,red) -> orange; >= red -> red.
 */
export function classifyZone(pct: number, thresholds: ZoneThresholds): ZoneName {
  if (pct >= thresholds.red) return 'red';
  if (pct >= thresholds.orange) return 'orange';
  if (pct >= thresholds.yellow) return 'yellow';
  return 'green';
}
