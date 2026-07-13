// T006 — Constitution Principle III: src/core/ must never import from src/adapters/ or src/cli/.
// Feature 002 T002 — src/core/ must also never import src/mcp/, and src/mcp/ must never
// import src/cli/ (launcher direction is cli → mcp only).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(repoRoot, 'src', 'core');
const mcpDir = join(repoRoot, 'src', 'mcp');
const cliDir = join(repoRoot, 'src', 'cli');
const forbiddenForCore = [join(repoRoot, 'src', 'adapters'), cliDir, mcpDir];
const forbiddenForMcp = [cliDir];

// Matches static imports, re-exports, dynamic import(), and require() specifiers.
const IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function resolvedTarget(spec: string, importerFile: string): string | null {
  if (spec.startsWith('.')) return resolve(dirname(importerFile), spec);
  if (spec.startsWith('src/')) return resolve(repoRoot, spec);
  return null; // bare package specifier — not a workspace path
}

function importViolations(sourceDir: string, forbiddenDirs: string[]): string[] {
  const violations: string[] = [];
  for (const file of sourceFilesUnder(sourceDir)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const target = resolvedTarget(spec, file);
      if (target === null) continue;
      if (forbiddenDirs.some((dir) => target === dir || target.startsWith(dir + sep))) {
        violations.push(`${relative(repoRoot, file)} imports "${spec}"`);
      }
    }
  }
  return violations;
}

describe('architecture boundary (constitution Principle III)', () => {
  it('no file in src/core imports from src/adapters, src/cli, or src/mcp', () => {
    expect(importViolations(coreDir, forbiddenForCore)).toEqual([]);
  });

  it('no file in src/mcp imports from src/cli (launcher direction is cli → mcp only)', () => {
    expect(importViolations(mcpDir, forbiddenForMcp)).toEqual([]);
  });
});
