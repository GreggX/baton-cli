// T010 — Zone threshold schema (data-model.md ZoneThresholds).
// Validation rule (FR-003): 0 < yellow < orange < red <= 100; violations produce
// ConfigError entries naming key, value, and rule; the system continues on defaults.
import { z } from 'zod';

/**
 * Canonical default thresholds (constitution Operational Constraints).
 * Defined once; consumed everywhere. MUST NOT drift across the codebase.
 */
export const DEFAULT_THRESHOLDS: ZoneThresholds = Object.freeze({
  yellow: 40,
  orange: 60,
  red: 75,
});

/** A named configuration violation: which key, what value, which rule it broke (FR-003). */
export interface ConfigError {
  key: string;
  value: unknown;
  rule: string;
}

export const zoneThresholdsSchema = z
  .object({
    yellow: z.number().default(40),
    orange: z.number().default(60),
    red: z.number().default(75),
  })
  .superRefine((thresholds, ctx) => {
    if (!(thresholds.yellow > 0)) {
      ctx.addIssue({ code: 'custom', path: ['yellow'], message: 'must be greater than 0' });
    }
    if (!(thresholds.orange > thresholds.yellow)) {
      ctx.addIssue({
        code: 'custom',
        path: ['orange'],
        message: `must be greater than thresholds.yellow (${thresholds.yellow})`,
      });
    }
    if (!(thresholds.red > thresholds.orange)) {
      ctx.addIssue({
        code: 'custom',
        path: ['red'],
        message: `must be greater than thresholds.orange (${thresholds.orange})`,
      });
    }
    if (!(thresholds.red <= 100)) {
      ctx.addIssue({ code: 'custom', path: ['red'], message: 'must be at most 100' });
    }
  });

export interface ZoneThresholds {
  yellow: number;
  orange: number;
  red: number;
}

/** Result of validating a raw thresholds value: effective thresholds + named violations. */
export interface ThresholdValidation {
  thresholds: ZoneThresholds;
  errors: ConfigError[];
}

/** Zod mirror of ConfigError for output-contract validation. */
export const configErrorSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  rule: z.string(),
});

/**
 * JSON contract for `baton context config show|validate --json`
 * (contracts/cli-interface.md; shared with the future MCP surface — Principle V).
 * Effective thresholds always satisfy the ordering refinement: either the file's
 * valid values or the canonical defaults.
 */
export const configReportSchema = z.object({
  valid: z.boolean(),
  thresholds: zoneThresholdsSchema,
  source: z.enum(['file', 'defaults']),
  errors: z.array(configErrorSchema),
});
export type ConfigReport = z.infer<typeof configReportSchema>;

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function issueToConfigError(issue: z.core.$ZodIssue, input: unknown): ConfigError {
  const key =
    issue.path.length > 0 ? `thresholds.${issue.path.join('.')}` : 'thresholds';
  const value = issue.path.length > 0 ? valueAtPath(input, issue.path) : input;
  let rule = issue.message;
  if (issue.code === 'invalid_type') {
    rule = issue.path.length > 0 ? 'must be a number' : 'must be an object';
  }
  return { key, value, rule };
}

/**
 * Validate a raw `thresholds` value from configuration.
 * Invalid input is never fatal: violations are returned as named ConfigErrors and the
 * effective thresholds fall back to the canonical defaults (FR-003).
 */
export function validateThresholds(input: unknown): ThresholdValidation {
  const result = zoneThresholdsSchema.safeParse(input ?? {});
  if (result.success) {
    return { thresholds: result.data, errors: [] };
  }
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    errors: result.error.issues.map((issue) => issueToConfigError(issue, input)),
  };
}
