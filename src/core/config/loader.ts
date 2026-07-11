// T010 — baton.config.json loader.
// Absent file -> defaults. Invalid file -> named ConfigError list, continue on defaults
// (FR-003: invalid config is never fatal). Reads only the tool's own config file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigError, ConfigReport, ZoneThresholds } from './schema.js';
import { DEFAULT_THRESHOLDS, validateThresholds } from './schema.js';

export const CONFIG_FILE_NAME = 'baton.config.json';

/** Effective configuration plus where it came from and any named violations. */
export interface LoadedConfig {
  thresholds: ZoneThresholds;
  source: 'file' | 'defaults';
  errors: ConfigError[];
}

function defaultsConfig(errors: ConfigError[] = []): LoadedConfig {
  return { thresholds: { ...DEFAULT_THRESHOLDS }, source: 'defaults', errors };
}

/**
 * Shape a loaded config into the `config show|validate` JSON contract
 * (configReportSchema — shared by the CLI --json output and the future MCP surface).
 */
export function toConfigReport(config: LoadedConfig): ConfigReport {
  return {
    valid: config.errors.length === 0,
    thresholds: config.thresholds,
    source: config.source,
    errors: config.errors,
  };
}

/**
 * Load `baton.config.json` from the workspace.
 * - no file -> defaults, no errors
 * - malformed JSON / non-object root -> defaults + one named error
 * - invalid thresholds -> defaults + one named error per violated key/rule
 * - valid thresholds -> file values, source "file"
 */
export function loadConfig(workspace: string): LoadedConfig {
  const configPath = join(workspace, CONFIG_FILE_NAME);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return defaultsConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultsConfig([{ key: CONFIG_FILE_NAME, value: null, rule: 'must be valid JSON' }]);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultsConfig([
      { key: CONFIG_FILE_NAME, value: parsed, rule: 'must be a JSON object' },
    ]);
  }

  if (!('thresholds' in parsed)) {
    return defaultsConfig();
  }

  const { thresholds, errors } = validateThresholds(
    (parsed as Record<string, unknown>)['thresholds'],
  );
  if (errors.length > 0) {
    return { thresholds, source: 'defaults', errors };
  }
  return { thresholds, source: 'file', errors };
}
