import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const planted = readFileSync(resolve(here, 'fixtures/illegal-import.ts.txt'), 'utf8');

describe('catalog import-boundary HARD GATE fails closed', () => {
  it('reports the React root @json-render/ink + react imports as ERRORS', async () => {
    const eslint = new ESLint({
      cwd: resolve(here, '..'),
      overrideConfigFile: resolve(here, '../eslint.config.js'),
    });
    const results = await eslint.lintText(planted, {
      filePath: resolve(here, '../src/__planted__.ts'),
    });
    const messages = results.flatMap((r) => r.messages);
    const errors = messages.filter((m) => m.severity === 2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    // hard gate: zero warning-level downgrades
    expect(messages.filter((m) => m.severity === 1)).toHaveLength(0);
  });

  it('the @json-render/ink/server subpath passes the gate (the allowed React-free entry)', async () => {
    const eslint = new ESLint({
      cwd: resolve(here, '..'),
      overrideConfigFile: resolve(here, '../eslint.config.js'),
    });
    const clean =
      `import { standardComponentDefinitions } from '@json-render/ink/server';\n` +
      `import { defineCatalog } from '@json-render/core';\n` +
      `import type { AppSpec } from '@minitui/types';\n` +
      `export const x = [standardComponentDefinitions, defineCatalog] satisfies unknown[];\n` +
      `export type Y = AppSpec;\n`;
    const results = await eslint.lintText(clean, {
      filePath: resolve(here, '../src/__clean__.ts'),
    });
    const errors = results.flatMap((r) => r.messages).filter((m) => m.severity === 2);
    expect(errors).toHaveLength(0);
  });
});
