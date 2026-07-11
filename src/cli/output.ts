// T020 — stdout/stderr separation helpers and the exit-code map
// (contracts/cli-interface.md, constitution Principle V).
//
// Conventions:
//   stdout = results (human-readable by default, machine JSON with --json)
//   stderr = diagnostics, warnings, progress

/**
 * Exit-code map per contracts/cli-interface.md.
 * Invalid *config* is NOT fatal: warning on stderr + defaults (FR-003), exit code
 * unaffected — except `config validate`, whose contract is exit 2 on invalid.
 */
export const EXIT = {
  /** success (including "estimated" readings and empty scan results) */
  ok: 0,
  /** unexpected runtime error */
  runtimeError: 1,
  /** invalid invocation (bad args) */
  invalidInvocation: 2,
  /** no session / reading unavailable */
  noSession: 3,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Write a human-readable result line to stdout. */
export function result(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Write a machine-readable JSON result to stdout as a single parseable document
 * (pretty-printed; still one valid JSON value end-to-end).
 */
export function jsonResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Write one compact NDJSON event line to stdout (e.g. the `watch --json` stream). */
export function ndjsonEvent(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Write a diagnostic / warning / progress line to stderr — never to stdout. */
export function diagnostic(text: string): void {
  process.stderr.write(`${text}\n`);
}
