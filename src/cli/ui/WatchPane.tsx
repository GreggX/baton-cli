// T028 — Ink watch pane (design 1c) with the 5a data-state treatments.
// Left column: big pct + zone pill, meter with threshold ticks + zone legend,
// TOKENS, BURN. Right column: HISTORY columns with threshold guide lines and the
// FORECAST box. Footer keys: q quit · z zones · a candidates · h handoff.
// Data states: LIVE (updated Ns ago), STALE (dashed border, demoted last-good
// reading, retrying source…), UNKNOWN (◌ --% UNKNOWN, empty bar) — a zone is never
// rendered as live without data (FR-011).
import { Box, Text, useInput } from 'ink';
import type { JSX } from 'react';
import { useState } from 'react';
import type { ZoneThresholds } from '../../core/config/schema.js';
import { saveSuggestionsPendingLine } from '../../core/heuristics/proactive.js';
import {
  burnPerTurn,
  secondsPerTurn,
  sparklineSamples,
} from '../../core/monitor/reader.js';
import type { Recommendation, UsageReading, ZoneName } from '../../core/monitor/types.js';
import {
  BAR_CELLS,
  FAINT_COLOR,
  MUTED_COLOR,
  UNKNOWN_COLOR,
  ZONE_COLORS,
  formatBar,
  formatBurn,
  formatForecast,
  formatAge,
  formatTokens,
} from './format.js';
import { TrafficLight } from './TrafficLight.js';
import type { TransitionBannerModel } from './TransitionBanner.js';
import { TransitionBanner } from './TransitionBanner.js';

export type WatchDataState = 'live' | 'stale' | 'unknown';

/** Verbatim event-log header (design 2b footer log). */
export const EVENT_LOG_HEADER = 'FIRED — NEWEST FIRST · ONE PER CROSSING';

export interface WatchViewModel {
  workspace: string;
  sessionId: string;
  thresholds: ZoneThresholds;
  dataState: WatchDataState;
  /** current reading (live) or the demoted last-good reading (stale); null → unknown */
  reading: UsageReading | null;
  zone: ZoneName | null;
  /** unavailable reason (stale/unknown) */
  reason: string | null;
  history: readonly UsageReading[];
  /** wall-clock ms for the age stamps (presentation only) */
  nowMs: number;
  guidance: string | null;
  /** active transition toast (auto-quiets ~6s); null when quiet (US2) */
  banner: TransitionBannerModel | null;
  /** pending advisories — d dismiss, enter act (US2) */
  pending: readonly Recommendation[];
  /** pending save suggestions from the proactive scan, aggregated for display (US3/FR-015) */
  saveSuggestions: readonly Recommendation[];
  /** in-pane event log, newest first, max 4 entries (US2) */
  events: readonly string[];
  /** quiet recovery stamp (`● BACK IN GREEN · … · notices re-armed`) */
  recovery: string | null;
  /** anti-nag note after a dismissal (`— still orange, no repeat`) */
  suppressedNote: string | null;
}

export interface WatchPaneProps {
  view: WatchViewModel;
  onQuit: () => void;
  onDismiss: () => void;
  onAct: () => void;
  /** dismiss ALL pending save suggestions — per-candidate, never re-offered */
  onDismissSuggestions: () => void;
}

/** Dashed border for the STALE treatment (design 5a). */
const DASHED_BORDER = {
  topLeft: '┌',
  top: '╌',
  topRight: '┐',
  right: '┆',
  bottomRight: '┘',
  bottom: '╌',
  bottomLeft: '└',
  left: '┆',
} as const;

function readingAgeSeconds(reading: UsageReading, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(reading.timestamp)) / 1000));
}

/** Threshold tick row aligned under the 22-cell meter (offset for the ▕ edge). */
function tickRow(thresholds: ZoneThresholds, cells: number = BAR_CELLS): string {
  const row = Array.from({ length: cells }, () => ' ');
  for (const value of [thresholds.yellow, thresholds.orange, thresholds.red]) {
    const cell = Math.min(cells - 1, Math.max(0, Math.round((value / 100) * cells) - 1));
    row[cell] = '╵';
  }
  return ` ${row.join('')}`;
}

const HISTORY_ROWS = 4;
const HISTORY_COLUMNS = 12;
const COLUMN_RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

interface HistoryRow {
  cells: string;
  guide: string; // threshold label for this band, '' when none
}

/**
 * HISTORY columns: last 12 samples as vertical columns over HISTORY_ROWS bands,
 * with threshold guide lines marking the band each threshold falls in.
 */
function historyRows(samples: readonly number[], thresholds: ZoneThresholds): HistoryRow[] {
  const bandSize = 100 / HISTORY_ROWS;
  const recent = samples.slice(-HISTORY_COLUMNS);
  const rows: HistoryRow[] = [];
  for (let rowIndex = 0; rowIndex < HISTORY_ROWS; rowIndex += 1) {
    const bandLow = (HISTORY_ROWS - rowIndex - 1) * bandSize;
    const guides = [thresholds.yellow, thresholds.orange, thresholds.red].filter(
      (value) => value >= bandLow && value < bandLow + bandSize,
    );
    const isGuideRow = guides.length > 0;
    let cells = '';
    for (const pct of recent) {
      const fraction = (pct - bandLow) / bandSize;
      if (fraction >= 1) {
        cells += '█';
      } else if (fraction > 0) {
        const rampIndex = Math.min(
          COLUMN_RAMP.length - 1,
          Math.max(0, Math.floor(fraction * COLUMN_RAMP.length)),
        );
        cells += COLUMN_RAMP[rampIndex];
      } else {
        cells += isGuideRow ? '·' : ' ';
      }
    }
    cells = cells.padEnd(HISTORY_COLUMNS, isGuideRow ? '·' : ' ');
    rows.push({
      cells,
      guide: isGuideRow ? ` ─ ${guides.map((value) => String(value)).join('/')}` : '',
    });
  }
  return rows;
}

export function WatchPane(props: WatchPaneProps): JSX.Element {
  const { view, onQuit, onDismiss, onAct, onDismissSuggestions } = props;
  const [showZones, setShowZones] = useState(true);
  const [reviewSuggestions, setReviewSuggestions] = useState(false);

  // While a banner/zone advisory is up, TransitionBanner owns 'd' (US2);
  // otherwise 'd' dismisses the aggregated save suggestions (US3/FR-015).
  const bannerOwnsDismiss = view.banner !== null || view.pending.length > 0;

  useInput((input) => {
    if (input === 'q') onQuit();
    if (input === 'z') setShowZones((current) => !current);
    if (input === 'a') setReviewSuggestions((current) => !current);
    if (input === 'd' && !bannerOwnsDismiss && view.saveSuggestions.length > 0) {
      onDismissSuggestions();
    }
    // 'h' (handoff) is wired by US4; 'd'/'enter' for zone advisories live in
    // TransitionBanner (US2).
  });

  const { thresholds } = view;
  const stale = view.dataState === 'stale';
  const unknown = view.dataState === 'unknown';
  const reading = view.reading;
  const pct = reading?.pct ?? null;
  const burn = burnPerTurn(view.history);

  return (
    <Box
      flexDirection="column"
      borderStyle={stale ? DASHED_BORDER : 'round'}
      borderColor={stale || unknown ? UNKNOWN_COLOR : FAINT_COLOR}
      paddingX={1}
    >
      {/* header: data-state treatment (design 5a) */}
      {stale && reading !== null ? (
        <Box gap={1}>
          <Text color="yellow">{`⚠ STALE · last good ${formatAge(readingAgeSeconds(reading, view.nowMs))} ago →`}</Text>
          <TrafficLight zone={view.zone} pct={pct} precision={reading.precision} demoted />
          <Text color={MUTED_COLOR}>retrying source…</Text>
        </Box>
      ) : (
        <Box gap={1}>
          <TrafficLight
            zone={unknown ? null : view.zone}
            pct={unknown ? null : pct}
            precision={reading?.precision}
            dataAgeSeconds={
              !unknown && reading !== null ? readingAgeSeconds(reading, view.nowMs) : null
            }
          />
        </Box>
      )}
      {unknown ? (
        <Text color={MUTED_COLOR}>
          {view.reason ?? 'no reading available'}
          {reading !== null
            ? ` · last good reading ${formatAge(readingAgeSeconds(reading, view.nowMs))} ago`
            : ''}
        </Text>
      ) : null}

      <Box marginTop={1} flexDirection="row" gap={3}>
        {/* left column: meter + ticks + legend, TOKENS, BURN */}
        <Box flexDirection="column">
          <Text dimColor={stale}>{formatBar(unknown ? null : pct)}</Text>
          <Text color={FAINT_COLOR}>{tickRow(thresholds)}</Text>
          {showZones ? (
            <Box gap={1}>
              <Text color={ZONE_COLORS.yellow}>{`${String(thresholds.yellow)} yellow`}</Text>
              <Text color={MUTED_COLOR}>·</Text>
              <Text color={ZONE_COLORS.orange}>{`${String(thresholds.orange)} orange`}</Text>
              <Text color={MUTED_COLOR}>·</Text>
              <Text color={ZONE_COLORS.red}>{`${String(thresholds.red)} red`}</Text>
            </Box>
          ) : null}
          <Box marginTop={1} gap={2}>
            <Text>
              <Text color={MUTED_COLOR}>TOKENS </Text>
              {reading !== null
                ? formatTokens(reading.tokensUsed, reading.contextWindow)
                : '--'}
              {reading?.precision === 'estimated' ? (
                <Text color={MUTED_COLOR} italic>
                  {' '}
                  estimated
                </Text>
              ) : null}
            </Text>
            <Text>
              <Text color={MUTED_COLOR}>BURN </Text>
              {formatBurn(burn)}
            </Text>
          </Box>
          {view.guidance !== null && !unknown ? (
            <Text color={MUTED_COLOR}>{view.guidance}</Text>
          ) : null}
        </Box>

        {/* right column: HISTORY columns + FORECAST box */}
        <Box flexDirection="column">
          <Text color={MUTED_COLOR}>HISTORY</Text>
          {historyRows(sparklineSamples(view.history), thresholds).map((row, index) => (
            <Text key={index}>
              <Text color={view.zone !== null ? ZONE_COLORS[view.zone] : UNKNOWN_COLOR}>
                {row.cells}
              </Text>
              <Text color={FAINT_COLOR}>{row.guide}</Text>
            </Text>
          ))}
          <Box borderStyle="single" borderColor={FAINT_COLOR} paddingX={1} marginTop={1}>
            <Text>
              <Text color={MUTED_COLOR}>FORECAST </Text>
              {!unknown && view.zone !== null && pct !== null
                ? formatForecast(
                    view.zone,
                    pct,
                    burn,
                    thresholds.red,
                    secondsPerTurn(view.history),
                  )
                : '--'}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* transition banner / recovery stamp / pending advisories (US2, design 2a/2b) */}
      <TransitionBanner
        banner={view.banner}
        pending={view.pending}
        recovery={view.recovery}
        suppressedNote={view.suppressedNote}
        onDismiss={onDismiss}
        onAct={onAct}
      />

      {/* aggregated pending save suggestions (US3/FR-015): per-candidate model,
          aggregated display — `a` expands the review list, `d` dismisses */}
      {view.saveSuggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={ZONE_COLORS.orange}>
            {saveSuggestionsPendingLine(view.saveSuggestions.length)}
          </Text>
          {reviewSuggestions
            ? view.saveSuggestions.map((suggestion) => (
                <Text key={suggestion.id} color={MUTED_COLOR}>
                  {`  ${suggestion.guidance}`}
                </Text>
              ))
            : null}
        </Box>
      ) : null}

      {/* in-pane event log: newest first, one entry per crossing, keep 4 (design 2b) */}
      {view.events.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={MUTED_COLOR}>{EVENT_LOG_HEADER}</Text>
          {view.events.map((entry, index) => (
            <Text key={index} dimColor={index > 0}>
              {entry}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* footer keys (design 1c, + d dismiss from 2b) */}
      <Box marginTop={1}>
        <Text color={MUTED_COLOR}>q quit · z zones · a candidates · h handoff · d dismiss</Text>
      </Box>
    </Box>
  );
}

export default WatchPane;
