import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
          // Several integration files spawn CLI child processes and assert hard
          // wall-clock guarantees (FR-001 ≤10 s refresh, <5 s scan) — run these
          // files sequentially so parallel load cannot breach the deadlines.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['tests/contract/**/*.test.{ts,tsx}'],
          passWithNoTests: true,
          // contract tests spawn the CLI as a child process (tsx) — allow cold starts
          testTimeout: 30_000,
          // watch-events asserts FR-001/SC-002 10 s windows — same rationale.
          fileParallelism: false,
        },
      },
    ],
  },
});
