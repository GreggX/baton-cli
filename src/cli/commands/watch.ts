// T028 — `baton context watch` (US1, FR-001/FR-004).
// T035 — US2 wiring: zone transitions + recommendations (FR-005/FR-006/FR-014).
//
// Interactive TTY: Ink live view (design 1c pane with 5a LIVE/STALE/UNKNOWN
// treatments) plus the 2a/2b transition treatments — a banner per boundary
// crossing that auto-quiets after ~6 s, a quiet recovery stamp on de-escalation
// to green, an in-pane event log (newest first, max 4), and pending advisories
// with `d` dismiss / `enter` act. Non-TTY or --json: NDJSON event stream — one
// compact object per line: `reading` events with the zone, one `zone_transition`
// per boundary change (final zone only on multi-band jumps), `recommendation`
// events with mandatory triggers, and explicit `reading_unavailable` events when
// no reading is producible (never a fabricated zone, FR-011).
//
// The only unprompted write anywhere is the tool's own `.baton/state.json`
// (persisted lastZone for restart continuity + dismissal bookkeeping, FR-014).
//
// Refresh: file-watch events (500 ms debounce) with a polling fallback tuned by
// `--interval <seconds>` (default 5, min 1, max 10 — capped so user tuning cannot
// breach the FR-001 ≤10 s guarantee; out-of-range exits 2). SIGINT exits 0.
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { createClaudeCodeSessionSource } from '../../adapters/claude-code/session-source.js';
import { loadConfig } from '../../core/config/loader.js';
import type { ZoneThresholds } from '../../core/config/schema.js';
import {
  dismissCandidate,
  isProactiveZone,
  proactiveScan,
  savedCandidateIds,
} from '../../core/heuristics/proactive.js';
import { HEURISTIC_RULES } from '../../core/heuristics/rules.js';
import type { WatchReadingEvent, WatchUnavailableEvent } from '../../core/monitor/reader.js';
import {
  readStatus,
  watchReadingEventSchema,
  watchRecommendationEventSchema,
  watchTransitionEventSchema,
  watchUnavailableEventSchema,
} from '../../core/monitor/reader.js';
import { advanceMonitor, dismiss } from '../../core/monitor/recommendations.js';
import type { SessionSource } from '../../core/monitor/session-source.js';
import { loadMonitorState, saveMonitorState } from '../../core/monitor/state.js';
import { crossingSummary, transitionSubtitle } from '../../core/monitor/transitions.js';
import type {
  MonitorState,
  SessionRef,
  UsageReading,
  ZoneTransition,
} from '../../core/monitor/types.js';
import { ZONE_GUIDANCE, classifyZone } from '../../core/monitor/zones.js';
import { ZONE_GLYPHS } from '../ui/format.js';
import type { WatchViewModel } from '../ui/WatchPane.js';
import { WatchPane } from '../ui/WatchPane.js';
import type { GlobalOptions } from '../index.js';
import { EXIT, diagnostic, ndjsonEvent } from '../output.js';
import { rejectionLines } from './config.js';

/** --interval bounds (contract: min 1, max 10 — protects the FR-001 guarantee). */
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 10;
export const DEFAULT_INTERVAL_SECONDS = 5;

/** Transition banner auto-quiets after ~6 s (design 2b toast). */
export const BANNER_QUIET_MS = 6000;

/** In-pane event log keeps the newest 4 entries (design 2b). */
export const EVENT_LOG_MAX = 4;

interface WatchOptions extends GlobalOptions {
  interval?: string;
}

/** Register `watch` under the `context` command group. */
export function registerWatchCommand(context: Command): void {
  context
    .command('watch')
    .description('Continuously updating live view of context usage')
    .option(
      '--interval <seconds>',
      `polling fallback interval in seconds (default ${String(DEFAULT_INTERVAL_SECONDS)}, min ${String(MIN_INTERVAL_SECONDS)}, max ${String(MAX_INTERVAL_SECONDS)})`,
      String(DEFAULT_INTERVAL_SECONDS),
    )
    .action(async (_opts: WatchOptions, command: Command) => {
      await runWatch(command);
    });
}

async function runWatch(command: Command): Promise<void> {
  const opts = command.optsWithGlobals<WatchOptions>();

  const interval = Number(opts.interval ?? String(DEFAULT_INTERVAL_SECONDS));
  if (
    !Number.isFinite(interval) ||
    interval < MIN_INTERVAL_SECONDS ||
    interval > MAX_INTERVAL_SECONDS
  ) {
    diagnostic(
      `invalid --interval "${String(opts.interval)}" — must be a number between ${String(MIN_INTERVAL_SECONDS)} and ${String(MAX_INTERVAL_SECONDS)} seconds`,
    );
    process.exitCode = EXIT.invalidInvocation;
    return;
  }

  const workspace = resolve(opts.workspace ?? process.cwd());
  const config = loadConfig(workspace);
  if (config.errors.length > 0) {
    // Tolerated-fallback path: warn on stderr, continue on defaults (FR-003).
    for (const line of rejectionLines(config.errors)) diagnostic(line);
  }

  const source = createClaudeCodeSessionSource({ pollIntervalSeconds: interval });
  const session = await source.resolveSession({ workspace, sessionId: opts.session });
  if (session === null) {
    diagnostic(`no session found for workspace ${workspace}`);
    process.exitCode = EXIT.noSession;
    return;
  }

  const interactive =
    opts.json !== true && process.stdout.isTTY === true && process.stdin.isTTY === true;
  const shared: WatchRuntime = {
    source,
    session,
    workspace,
    sessionId: opts.session,
    thresholds: config.thresholds,
  };
  if (interactive) {
    await runInteractiveWatch(shared);
  } else {
    await runNdjsonWatch(shared);
  }
}

interface WatchRuntime {
  source: SessionSource;
  session: SessionRef;
  workspace: string;
  sessionId: string | undefined;
  thresholds: ZoneThresholds;
}

/** Serialize refreshes: a change during an in-flight refresh queues exactly one more. */
function makeRefreshScheduler(refresh: () => Promise<void>): () => void {
  let running = false;
  let pending = false;
  const schedule = (): void => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void refresh().finally(() => {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    });
  };
  return schedule;
}

/**
 * Per-session monitor state shared by both watch modes: keeps `.baton/state.json`
 * loaded for the session in view (session rollover ⇒ fresh per-session state) and
 * persists it only when it actually changed — the tool's single unprompted write.
 */
interface StateTracker {
  current: MonitorState;
  /** re-key to a (possibly new) session id */
  ensureSession(currentSessionId: string): boolean;
  /** persist `next` when it differs from the loaded state */
  commit(next: MonitorState): void;
}

function makeStateTracker(workspace: string, initialSessionId: string): StateTracker {
  const tracker: StateTracker = {
    current: loadMonitorState(workspace, initialSessionId),
    ensureSession(currentSessionId: string): boolean {
      if (currentSessionId === tracker.current.sessionId) return false;
      tracker.current = loadMonitorState(workspace, currentSessionId);
      return true;
    },
    commit(next: MonitorState): void {
      if (JSON.stringify(next) !== JSON.stringify(tracker.current)) {
        saveMonitorState(workspace, next); // the only unprompted write (.baton/state.json)
      }
      tracker.current = next;
    },
  };
  return tracker;
}

// ── NDJSON stream (non-TTY / --json) ──────────────────────────────────────────

async function runNdjsonWatch(runtime: WatchRuntime): Promise<void> {
  const { source, session, workspace, sessionId, thresholds } = runtime;

  const state = makeStateTracker(workspace, session.id);
  let lastGoodReading: UsageReading | null = null;
  let lastEmittedKey = '';
  // Candidate ids already offered in this run: one save_candidate event per
  // candidate, never re-emitted on later refreshes (FR-015).
  let offeredCandidates = new Set<string>();

  const refresh = async (): Promise<void> => {
    const status = await readStatus(source, {
      workspace,
      sessionId,
      thresholds,
      now: new Date(),
    });
    if (status.state === 'ok') {
      if (state.ensureSession(status.session.id)) {
        lastGoodReading = null;
        offeredCandidates = new Set();
      }

      const event: WatchReadingEvent = watchReadingEventSchema.parse({
        event: 'reading',
        reading: status.reading,
        zone: status.zone,
      });
      // Emit only when the event differs from the last one (readings carry stable
      // transcript timestamps, so identical re-reads dedupe cleanly).
      const key = JSON.stringify(event);
      if (key !== lastEmittedKey) {
        lastEmittedKey = key;
        ndjsonEvent(event);
      }

      // US2: one zone_transition per boundary change (final zone only on
      // multi-band jumps, FR-005) + its pending advisory unless dismissed in the
      // unchanged zone (FR-014).
      const advance = advanceMonitor({
        state: state.current,
        reading: status.reading,
        thresholds,
        fromPct: lastGoodReading?.pct ?? null,
      });
      if (advance.transition !== null) {
        ndjsonEvent(
          watchTransitionEventSchema.parse({
            event: 'zone_transition',
            transition: advance.transition,
            guidance: ZONE_GUIDANCE[advance.transition.to],
          }),
        );
      }
      if (advance.recommendation !== null) {
        ndjsonEvent(
          watchRecommendationEventSchema.parse({
            event: 'recommendation',
            recommendation: advance.recommendation,
          }),
        );
      }

      // US3/FR-015: while in orange/red, an automatic READ-ONLY scan runs on
      // zone entry and on refresh — one save_candidate recommendation per new
      // candidate; saved/dismissed candidates are never re-emitted.
      if (isProactiveZone(advance.zone)) {
        const proactive = proactiveScan({
          sessionId: status.session.id,
          zone: advance.zone,
          blocks: await source.contentForScan(status.session),
          rules: HEURISTIC_RULES,
          state: advance.state,
          savedCandidateIds: savedCandidateIds(workspace, status.session.id),
          offeredCandidateIds: offeredCandidates,
        });
        for (const recommendation of proactive.recommendations) {
          if (recommendation.trigger.kind === 'rule_match') {
            offeredCandidates.add(recommendation.trigger.candidateId);
          }
          ndjsonEvent(
            watchRecommendationEventSchema.parse({ event: 'recommendation', recommendation }),
          );
        }
      }

      state.commit(advance.state);
      lastGoodReading = status.reading;
    } else {
      // Unavailability is not a zone change: monitor state stays untouched and
      // no zone is ever fabricated (FR-011).
      const event: WatchUnavailableEvent = watchUnavailableEventSchema.parse({
        event: 'reading_unavailable',
        unavailable: {
          sessionId: status.session?.id ?? session.id,
          reason: status.reason,
          lastGoodReading: status.lastGoodReading ?? lastGoodReading,
        },
      });
      const key = JSON.stringify(event);
      if (key !== lastEmittedKey) {
        lastEmittedKey = key;
        ndjsonEvent(event);
      }
    }
  };

  const scheduleRefresh = makeRefreshScheduler(refresh);
  await refresh(); // initial reading before any change event
  const subscription = source.subscribeToChanges(session, scheduleRefresh);

  await new Promise<void>((resolveWait) => {
    const stop = (): void => {
      resolveWait();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await subscription.close();
  process.exitCode = EXIT.ok; // exit 0 on SIGINT per contract
}

// ── Interactive Ink view (TTY) ────────────────────────────────────────────────

async function runInteractiveWatch(runtime: WatchRuntime): Promise<void> {
  const { source, session, workspace, sessionId, thresholds } = runtime;

  const view: WatchViewModel = {
    workspace,
    sessionId: session.id,
    thresholds,
    dataState: 'unknown',
    reading: null,
    zone: null,
    reason: 'waiting for first reading…',
    history: [],
    nowMs: Date.now(),
    guidance: null,
    banner: null,
    pending: [],
    saveSuggestions: [],
    events: [],
    recovery: null,
    suppressedNote: null,
  };
  const state = makeStateTracker(workspace, session.id);
  let lastGoodReading: UsageReading | null = null;
  let bannerTimer: NodeJS.Timeout | null = null;

  /** Apply a detected transition to the pane (design 2a/2b treatments). */
  const applyTransition = (transition: ZoneTransition, fromPct: number | null): void => {
    const summary = crossingSummary(transition, thresholds, fromPct);
    view.suppressedNote = null;
    view.pending = []; // zone advice is zone-scoped: a crossing replaces it
    view.events = [
      `${ZONE_GLYPHS[transition.to]} ${transition.to.toUpperCase()} @ ${String(Math.round(transition.reading.pct))}% · ${summary}`,
      ...view.events,
    ].slice(0, EVENT_LOG_MAX);
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    if (transition.to === 'green') {
      // Recovery is a quiet stamp, not an alert (design 2b); attach into green
      // (from unknown) needs no stamp at all.
      view.banner = null;
      view.recovery =
        transition.from === 'unknown'
          ? null
          : `${ZONE_GLYPHS.green} BACK IN GREEN · ${summary} · notices re-armed`;
    } else {
      view.recovery = null;
      view.banner = {
        transition,
        subtitle: transitionSubtitle(transition, thresholds, fromPct),
      };
      // Toast auto-quiets after ~6 s; the event log keeps the audit trail.
      bannerTimer = setTimeout(() => {
        bannerTimer = null;
        view.banner = null;
        update();
      }, BANNER_QUIET_MS);
    }
  };

  const applyStatus = async (
    status: Awaited<ReturnType<typeof readStatus>>,
  ): Promise<void> => {
    if (status.state === 'ok') {
      if (state.ensureSession(status.session.id)) lastGoodReading = null;
      const advance = advanceMonitor({
        state: state.current,
        reading: status.reading,
        thresholds,
        fromPct: lastGoodReading?.pct ?? null,
      });
      if (advance.transition !== null) {
        applyTransition(advance.transition, lastGoodReading?.pct ?? null);
      }
      if (advance.recommendation !== null) {
        const incoming = advance.recommendation;
        view.pending = [incoming, ...view.pending.filter((p) => p.id !== incoming.id)];
      }

      // US3/FR-015: automatic read-only scan in orange/red — pending save
      // suggestions are aggregated for display, per-candidate in the model.
      if (isProactiveZone(advance.zone)) {
        const proactive = proactiveScan({
          sessionId: status.session.id,
          zone: advance.zone,
          blocks: await source.contentForScan(status.session),
          rules: HEURISTIC_RULES,
          state: advance.state,
          savedCandidateIds: savedCandidateIds(workspace, status.session.id),
        });
        view.saveSuggestions = proactive.recommendations;
      } else {
        view.saveSuggestions = [];
      }

      state.commit(advance.state);
      lastGoodReading = status.reading;
      view.dataState = 'live';
      view.reading = status.reading;
      view.zone = status.zone;
      view.reason = null;
      view.history = status.history;
      view.guidance = status.guidance;
      view.sessionId = status.session.id;
    } else if ((status.lastGoodReading ?? lastGoodReading) !== null) {
      // STALE: source stopped producing readings — demote the last good one (5a).
      const lastGood = status.lastGoodReading ?? lastGoodReading;
      view.dataState = 'stale';
      view.reading = lastGood;
      view.zone = lastGood !== null ? classifyZone(lastGood.pct, thresholds) : null;
      view.reason = status.reason;
      view.guidance = null;
    } else {
      view.dataState = 'unknown';
      view.reading = null;
      view.zone = null;
      view.reason = status.reason;
      view.guidance = null;
    }
    view.nowMs = Date.now();
  };

  // First reading before mounting so the pane never flashes a fabricated state.
  await applyStatus(
    await readStatus(source, { workspace, sessionId, thresholds, now: new Date() }),
  );

  let cleanedUp = false;
  let subscriptionClose: (() => Promise<void>) | null = null;
  let ticker: NodeJS.Timeout | null = null;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (ticker !== null) clearInterval(ticker);
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    if (subscriptionClose !== null) void subscriptionClose();
  };

  const onQuit = (): void => {
    cleanup();
    app.unmount();
  };

  /** `d`: dismiss the banner + first pending advisory; persisted, re-arms at the
   *  next boundary (FR-014). The dismissed zone stays quiet — no repeat. */
  const onDismiss = (): void => {
    view.banner = null;
    if (bannerTimer !== null) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    const target = view.pending[0];
    if (target !== undefined && view.zone !== null) {
      state.commit(dismiss(state.current, target.id, view.zone, new Date().toISOString()));
      view.pending = view.pending.filter((p) => p.id !== target.id);
      view.suppressedNote = `— still ${view.zone}, no repeat`;
    }
    update();
  };

  /** `enter`: act on the first pending advisory (advisory-only: marks it handled). */
  const onAct = (): void => {
    const target = view.pending[0];
    if (target === undefined) return;
    view.pending = view.pending.filter((p) => p.id !== target.id);
    view.banner = null;
    update();
  };

  /** `d` (no zone advisory pending): dismiss the aggregated save suggestions —
   *  each candidate is recorded individually and NEVER re-offered (FR-014/FR-015). */
  const onDismissSuggestions = (): void => {
    if (view.saveSuggestions.length === 0) return;
    let next = state.current;
    const dismissedAt = new Date().toISOString();
    for (const suggestion of view.saveSuggestions) {
      if (suggestion.trigger.kind === 'rule_match') {
        next = dismissCandidate(next, suggestion.trigger.candidateId, dismissedAt);
      }
    }
    state.commit(next);
    view.saveSuggestions = [];
    view.suppressedNote = '— save suggestions dismissed, never re-offered';
    update();
  };

  const paneElement = () =>
    createElement(WatchPane, {
      view: { ...view },
      onQuit,
      onDismiss,
      onAct,
      onDismissSuggestions,
    });
  const app = render(paneElement(), { exitOnCtrlC: true });
  const update = (): void => {
    app.rerender(paneElement());
  };

  const scheduleRefresh = makeRefreshScheduler(async () => {
    await applyStatus(
      await readStatus(source, { workspace, sessionId, thresholds, now: new Date() }),
    );
    update();
  });
  const subscription = source.subscribeToChanges(session, scheduleRefresh);
  subscriptionClose = () => subscription.close();

  // Presentation ticker: keeps the `updated Ns ago` stamps counting (1 Hz).
  ticker = setInterval(() => {
    view.nowMs = Date.now();
    update();
  }, 1000);

  process.once('SIGINT', onQuit);
  await app.waitUntilExit();
  cleanup();
  await subscription.close();
  process.exitCode = EXIT.ok;
}
