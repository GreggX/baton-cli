// T045 — CandidateReview: design 3a review loop copy (progress dots, rule pill +
// matched phrase, `on accept → path`, key hints), y/n/u keybindings, and the
// completion box with written paths / the no-files line.
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewItem } from '../../src/cli/ui/CandidateReview.js';
import {
  CandidateReview,
  NO_FILES_LINE,
  REVIEW_KEYS_LINE,
  wroteLine,
} from '../../src/cli/ui/CandidateReview.js';
import { CATEGORY_COLORS } from '../../src/core/heuristics/rules.js';

function item(id: string, ruleId: string, excerptCore: string): ReviewItem {
  return {
    candidate: {
      id,
      sessionId: 's-review',
      ruleId,
      excerpt: `We decided ${excerptCore}.`,
      span: { startLine: 2, endLine: 2 },
      status: 'surfaced',
    },
    category: 'decision',
    color: CATEGORY_COLORS.decision,
    matchedPhrase: 'we decided',
    location: 'turn 2 · assistant',
    pre: '',
    match: 'We decided',
    post: ` ${excerptCore}.`,
    targetPath: `.baton/artifacts/20260702-185000-${ruleId}-${id}.md`,
  };
}

const HEADER = '⏺ scanned 4 turns · 12 rules · 2 candidates · fingerprint a3f2c9';

/** Ink flushes React state updates asynchronously — yield between key presses. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('CandidateReview (Ink, design 3a)', () => {
  it('renders header, progress dots, rule pill, matched phrase, path, and keys', () => {
    const items = [item('c-1', 'decision.decided-to', 'to use the adapter approach')];
    const { lastFrame } = render(
      createElement(CandidateReview, {
        header: HEADER,
        items,
        written: null,
        onComplete: () => undefined,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(HEADER);
    expect(frame).toContain('◉'); // current dot
    expect(frame).toContain('candidate 1 of 1');
    expect(frame).toContain('decision.decided-to');
    expect(frame).toContain('matched "we decided"');
    expect(frame).toContain('turn 2 · assistant');
    expect(frame).toContain('on accept →');
    expect(frame).toContain(items[0]?.targetPath ?? '');
    expect(frame).toContain(REVIEW_KEYS_LINE);
  });

  it('y/n decide and advance; u undoes; completion fires once with accepted ids', async () => {
    const items = [
      item('c-1', 'decision.decided-to', 'to use the adapter approach'),
      item('c-2', 'decision.agreed-to', 'to cap retries at three'),
    ];
    const onComplete = vi.fn();
    const { stdin, lastFrame } = render(
      createElement(CandidateReview, { header: HEADER, items, written: null, onComplete }),
    );

    stdin.write('y'); // accept c-1
    await tick();
    expect(lastFrame()).toContain('✓');
    expect(lastFrame()).toContain('candidate 2 of 2');

    stdin.write('u'); // undo back to c-1
    await tick();
    expect(lastFrame()).toContain('candidate 1 of 2');

    stdin.write('y'); // accept c-1 again
    await tick();
    stdin.write('n'); // reject c-2
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✕');
    expect(frame).toContain('⏺ REVIEW COMPLETE — 1 accepted · 1 rejected');
    expect(frame).toContain(wroteLine(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(['c-1']);
  });

  it('all rejected: completion box shows the verbatim no-files line', async () => {
    const items = [item('c-1', 'decision.decided-to', 'to use the adapter approach')];
    const { stdin, lastFrame } = render(
      createElement(CandidateReview, {
        header: HEADER,
        items,
        written: null,
        onComplete: () => undefined,
      }),
    );
    stdin.write('n');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⏺ REVIEW COMPLETE — 0 accepted · 1 rejected');
    expect(frame).toContain(NO_FILES_LINE);
    expect(frame).not.toContain('+ .baton/artifacts/');
  });

  it('written paths render as + lines once the command persisted them', async () => {
    const items = [item('c-1', 'decision.decided-to', 'to use the adapter approach')];
    const onComplete = vi.fn();
    const { stdin, rerender, lastFrame } = render(
      createElement(CandidateReview, { header: HEADER, items, written: null, onComplete }),
    );
    stdin.write('y');
    await tick();
    const written = ['.baton/artifacts/20260702-185000-decision.decided-to-adapter-approach.md'];
    rerender(createElement(CandidateReview, { header: HEADER, items, written, onComplete }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain(`+ ${written[0] ?? ''}`);
    expect(frame).toContain(wroteLine(1));
  });
});
