import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const planted = readFileSync(resolve(here, 'fixtures/illegal-import.ts.txt'), 'utf8');
const WALLED = [
  '@json-render/ink',
  'react',
  '@json-render/ink/schema',
  '@json-render/ink/catalog',
  'ai',
];

describe('catalog import-boundary HARD GATE fails closed', () => {
  it('reports each walled import as an ERROR', async () => {
    const eslint = new ESLint({
      cwd: resolve(here, '..'),
      overrideConfigFile: resolve(here, '../eslint.config.js'),
    });
    const results = await eslint.lintText(planted, {
      filePath: resolve(here, '../src/__planted__.ts'),
    });
    const messages = results.flatMap((r) => r.messages);
    const errors = messages.filter((m) => m.severity === 2);
    // Each planted specifier must be flagged by name — the React root, react itself, both
    // non-/server subpaths (/schema, /catalog) and the AI SDK. The rule's message begins with the
    // quoted specifier, which tells the root from its subpaths: drop any one entry from the wall and
    // its own check fails, where a count of errors would still be met by the others.
    for (const specifier of WALLED) {
      expect(
        errors.some((m) => m.message.startsWith(`'${specifier}'`)),
        specifier,
      ).toBe(true);
    }
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
