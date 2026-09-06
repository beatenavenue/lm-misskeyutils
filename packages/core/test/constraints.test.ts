import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

/** Files that are allowed to touch the platform directly (default port implementations). */
const exemptFiles = new Set(['defaults.ts']);

const forbidden: Array<[RegExp, string]> = [
  [/from\s+['"]node:/, 'node: imports'],
  [/from\s+['"](fs|path|os|child_process|util|url)['"]/, 'Node builtin imports'],
  [/\bprocess\./, 'process.*'],
  [/\bconsole\./, 'console.*'],
  [/\bsetTimeout\s*\(/, 'setTimeout()'],
  [/\bsetInterval\s*\(/, 'setInterval()'],
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew Date\s*\(\s*\)/, 'new Date() without argument'],
];

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('core platform constraints (plan §3.2)', () => {
  const files = listSources(srcDir).filter((file) => !exemptFiles.has(relative(srcDir, file)));

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [relative(srcDir, file), file] as const))('%s', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      expect(source, `${label} is not allowed in core`).not.toMatch(pattern);
    }
  });
});
