// T027 — TrafficLight component: zone glyph + pct + zone pill, estimated label
// (FR-013), data age, and the unknown treatment that never fabricates a zone (FR-011).
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { TrafficLight } from '../../src/cli/ui/TrafficLight.js';

describe('TrafficLight (Ink)', () => {
  it('renders zone glyph, rounded pct, ZONE pill, and data age', () => {
    const { lastFrame } = render(
      createElement(TrafficLight, {
        zone: 'yellow',
        pct: 45.2,
        precision: 'exact',
        dataAgeSeconds: 3,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆');
    expect(frame).toContain('45%');
    expect(frame).toContain('YELLOW');
    expect(frame).toContain('updated 3s ago');
    expect(frame).not.toContain('estimated');
  });

  it('labels estimated readings visibly (FR-013)', () => {
    const { lastFrame } = render(
      createElement(TrafficLight, { zone: 'orange', pct: 68, precision: 'estimated' }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▲');
    expect(frame).toContain('68%');
    expect(frame).toContain('ORANGE');
    expect(frame).toContain('estimated');
  });

  it('unknown state renders ◌ --% UNKNOWN and no zone name (FR-011)', () => {
    const { lastFrame } = render(createElement(TrafficLight, { zone: null, pct: null }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◌ --%');
    expect(frame).toContain('UNKNOWN');
    for (const zoneName of ['GREEN', 'YELLOW', 'ORANGE', 'RED']) {
      expect(frame).not.toContain(zoneName);
    }
  });
});
