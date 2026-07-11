// T006 — Constitution Principle III: src/core/ must never import from src/adapters/ or src/cli/.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(repoRoot, 'src', 'core');
const forbiddenDirs = [join(repoRoot, 'src', 'adapters'), join(repoRoot, 'src', 'cli')];

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

describe('architecture boundary (constitution Principle III)', () => {
  it('no file in src/core imports from src/adapters or src/cli', () => {
    const violations: string[] = [];
    for (const file of sourceFilesUnder(coreDir)) {
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
    expect(violations).toEqual([]);
  });
});
