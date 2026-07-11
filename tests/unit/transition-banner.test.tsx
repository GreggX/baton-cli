// T036 — TransitionBanner: verbatim design copy (title, subtitle, advisory
// footer), pending advisory list, quiet recovery stamp, and the `d` dismiss /
// `enter` act keybindings.
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/core/config/schema.js';
import { recommendationForTransition } from '../../src/core/monitor/recommendations.js';
import { detectTransition, transitionSubtitle } from '../../src/core/monitor/transitions.js';
import type { UsageReading, ZoneTransition } from '../../src/core/monitor/types.js';
import { BANNER_FOOTER, TransitionBanner, bannerTitle } from '../../src/cli/ui/TransitionBanner.js';

function reading(pct: number): UsageReading {
  return {
    sessionId: 's-banner',
    tokensUsed: Math.round(pct * 2000),
    contextWindow: 200_000,
    pct,
    precision: 'exact',
    timestamp: '2026-07-02T18:00:00.000Z',
  };
}

function orangeJump(): ZoneTransition {
  const transition = detectTransition('green', reading(68), DEFAULT_THRESHOLDS);
  if (transition === null) throw new Error('expected transition');
  return transition;
}

const noop = (): void => undefined;

describe('TransitionBanner (Ink, design 2a/2b)', () => {
  it('renders title, multi-band subtitle, and the verbatim advisory footer', () => {
    const transition = orangeJump();
    expect(bannerTitle(transition)).toBe('▲ ENTERED ORANGE');
    const { lastFrame } = render(
      createElement(TransitionBanner, {
        banner: { transition, subtitle: transitionSubtitle(transition, DEFAULT_THRESHOLDS, 35) },
        pending: [],
        recovery: null,
        suppressedNote: null,
        onDismiss: noop,
        onAct: noop,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▲ ENTERED ORANGE');
    expect(frame).toContain('crossed 40% & 60% · now 68%');
    expect(frame).toContain(BANNER_FOOTER);
  });

  it('de-escalation title reads BACK IN <zone>', () => {
    const transition = detectTransition('orange', reading(30), DEFAULT_THRESHOLDS);
    if (transition === null) throw new Error('expected transition');
    expect(bannerTitle(transition)).toBe('● BACK IN GREEN');
  });

  it('renders pending advisories and the quiet recovery stamp', () => {
    const transition = orangeJump();
    const recommendation = recommendationForTransition(transition, DEFAULT_THRESHOLDS, 35);
    if (recommendation === null) throw new Error('expected recommendation');
    const { lastFrame } = render(
      createElement(TransitionBanner, {
        banner: null,
        pending: [recommendation],
        recovery: '● BACK IN GREEN · compaction 78% → 30% · notices re-armed',
        suppressedNote: '— still orange, no repeat',
        onDismiss: noop,
        onAct: noop,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('compact');
    // guidance may wrap in the frame — assert its trigger explanation fragment
    expect(frame).toContain('Entered orange — crossed 40% & 60% · now 68%');
    expect(frame).toContain('● BACK IN GREEN · compaction 78% → 30% · notices re-armed');
    expect(frame).toContain('— still orange, no repeat');
  });

  it('renders nothing when there is nothing to show', () => {
    const { lastFrame } = render(
      createElement(TransitionBanner, {
        banner: null,
        pending: [],
        recovery: null,
        suppressedNote: null,
        onDismiss: noop,
        onAct: noop,
      }),
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('`d` dismisses and `enter` acts', () => {
    const transition = orangeJump();
    const recommendation = recommendationForTransition(transition, DEFAULT_THRESHOLDS, 35);
    if (recommendation === null) throw new Error('expected recommendation');
    const onDismiss = vi.fn();
    const onAct = vi.fn();
    const { stdin } = render(
      createElement(TransitionBanner, {
        banner: { transition, subtitle: 'crossed 40% & 60% · now 68%' },
        pending: [recommendation],
        recovery: null,
        suppressedNote: null,
        onDismiss,
        onAct,
      }),
    );
    stdin.write('d');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    stdin.write('\r');
    expect(onAct).toHaveBeenCalledTimes(1);
  });
});
