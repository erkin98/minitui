import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// One row per forbidden specifier. Every family that carries a wildcard ban also
// plants a subpath, because `no-restricted-imports` `paths` matches EXACT strings
// only — `react` is banned as a literal but `react/jsx-runtime` bypasses it unless
// an anchored `react/*` pattern also catches it. Removing any single ban (a literal
// from `paths` or a `<pkg>/*` from `patterns`) leaves exactly its row unflagged, so
// the failure names the ban that regressed.
const FORBIDDEN = [
  // bare literals — matched by `paths`
  'react',
  'ink',
  '@json-render/ink',
  '@opentui/react',
  '@opentui/core',
  'node:child_process',
  'child_process',
  '@modelcontextprotocol/client',
  '@anthropic-ai/sandbox-runtime',
  'ai',
  // subpaths — the specifiers that slip past an exact-string ban, caught by `<pkg>/*`
  'react/jsx-runtime',
  'ink/hooks',
  '@json-render/ink/server',
  '@opentui/react/renderer',
  '@opentui/core/renderer',
  '@modelcontextprotocol/client/stdio',
  '@anthropic-ai/sandbox-runtime/exec',
  'ai/react',
  '@ai-sdk/openai',
  '@minitui/exec',
] as const;

// The ONE import renderer-core is allowed: the `@minitui/*` ban's negation must let
// `@minitui/types` through, and no other rule may catch it.
const ALLOWED = '@minitui/types';

function lint(source: string) {
  const eslint = new ESLint({
    cwd: resolve(here, '..'), // package root, so eslint.config.js loads
    overrideConfigFile: resolve(here, '../eslint.config.js'),
  });
  // lint the source AS IF it were a real src file (matches files: src/**/*.ts)
  return eslint.lintText(source, { filePath: resolve(here, '../src/__planted__.ts') });
}

describe('import-boundary HARD GATE fails closed', () => {
  it('flags every forbidden specifier and every subpath bypass at error level, one row each', async () => {
    // one import per line: line i+1 carries FORBIDDEN[i], so a missing error on that
    // line pins exactly which ban regressed. A trailing allowed import proves the gate
    // is discriminating, not a blanket "reject every import".
    const source =
      FORBIDDEN.map((spec) => `import '${spec}';`).join('\n') +
      `\nimport type { AppSpec } from '${ALLOWED}';\nexport type X = AppSpec;\n`;
    const allowedLine = FORBIDDEN.length + 1;

    const messages = (await lint(source)).flatMap((r) => r.messages);
    const errorLines = new Set(messages.filter((m) => m.severity === 2).map((m) => m.line));

    // per-row: every forbidden specifier's line must carry an error. The array names
    // any ban that failed to fire (e.g. an un-anchored subpath), not just a count.
    const unflagged = FORBIDDEN.filter((_, i) => !errorLines.has(i + 1));
    expect(unflagged).toEqual([]);

    // the one allowed import must NOT error — the negation carve-out holds
    expect(errorLines.has(allowedLine)).toBe(false);

    // every error is the boundary rule, and the gate is HARD — zero warning downgrades
    const errors = messages.filter((m) => m.severity === 2);
    expect(errors.every((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    expect(messages.filter((m) => m.severity === 1)).toHaveLength(0);
  });

  it('a clean import of @minitui/types alone passes the gate', async () => {
    const clean = `import type { AppSpec } from '${ALLOWED}';\nexport type X = AppSpec;\n`;
    const errors = (await lint(clean)).flatMap((r) => r.messages).filter((m) => m.severity === 2);
    expect(errors).toHaveLength(0);
  });
});
