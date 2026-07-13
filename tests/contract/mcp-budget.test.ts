// Feature 002 T012 — US1 budget test (contracts/mcp-tools.md obligation 3,
// SC-003 / FR-004): a context_status response — the routine health check — fits
// within 200 tokens of agent-visible content by the chars/4 rule (≤ 800 chars),
// is a single compact JSON document, and never embeds transcript content.
// Feature 002 T015 — the other routine response: an empty context_catchup
// (repeat call, nothing changed) fits the same budget.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolHandlers } from '../../src/mcp/tools.js';
import type { McpHarness } from './helpers/mcp-harness.js';
import { startMcpHarness } from './helpers/mcp-harness.js';

/** SC-003: 200 tokens by the chars/4 rule. */
const BUDGET_TOKENS = 200;
const BUDGET_CHARS = BUDGET_TOKENS * 4;

/** Fixture transcript passages that must NEVER appear in a tool response (FR-004). */
const TRANSCRIPT_PASSAGES = [
  'Walk through the transcript reader flow end to end.',
  'The context footprint sums input, cache reads, cache creation, and output tokens',
  'Now include the cache accounting fields in the total.',
];

let harness: McpHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

/** Every character of agent-visible content across the result's blocks. */
function agentVisibleText(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

describe('context_status response budget (T012, SC-003)', () => {
  it('ok response is ≤ 200 tokens (chars/4), compact single-document JSON', async () => {
    harness = await startMcpHarness({
      workspace: 'ws-yellow',
      handlers: createToolHandlers(),
    });
    const result = await harness.callTool('context_status');
    expect(result.isError ?? false).toBe(false);
    const text = agentVisibleText(result);
    expect(text.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(text).not.toContain('\n'); // compact serialization, no pretty-printing
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('unknown-state response also fits the routine budget', async () => {
    harness = await startMcpHarness({
      workspace: 'ws-empty',
      handlers: createToolHandlers(),
    });
    const result = await harness.callTool('context_status');
    expect(result.isError ?? false).toBe(false);
    expect(agentVisibleText(result).length).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('contains no transcript content (FR-004)', async () => {
    harness = await startMcpHarness({
      workspace: 'ws-yellow',
      handlers: createToolHandlers(),
    });
    const text = agentVisibleText(await harness.callTool('context_status'));
    for (const passage of TRANSCRIPT_PASSAGES) {
      expect(text).not.toContain(passage);
    }
  });
});

describe('empty context_catchup response budget (T015, SC-003)', () => {
  it('a repeat catch-up with nothing new is empty:true, ≤ 200 tokens, compact', async () => {
    harness = await startMcpHarness({
      workspace: 'ws-growing',
      handlers: createToolHandlers(),
    });
    await harness.callTool('context_catchup'); // first call creates the cursor
    const result = await harness.callTool('context_catchup'); // repeat: nothing changed
    expect(result.isError ?? false).toBe(false);
    const text = agentVisibleText(result);
    expect(text.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(text).not.toContain('\n'); // compact serialization
    const report = JSON.parse(text) as { empty?: boolean };
    expect(report.empty).toBe(true); // explicit empty result, not silence
    for (const passage of TRANSCRIPT_PASSAGES) {
      expect(text).not.toContain(passage);
    }
  });
});
