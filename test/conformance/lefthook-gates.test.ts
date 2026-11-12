import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The pre-push hook is the last local gate before a push, and a feature branch has no other check. The
// row pins the whole pre-push block as text, not a few parsed keys: a gate whose command changed, that
// left, or that gained a key narrowing when it runs (glob, skip, only, files) changes the text. It reads
// the pre-push block alone, because the pre-commit block runs some of the same commands.
const hooksFile = fileURLToPath(new URL('../../lefthook.yml', import.meta.url));

/** The text of one top-level block of the hooks file, up to the next top-level key. */
function blockOf(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) throw new Error(`the hooks file has no ${name} block`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** A block as lefthook reads it: comment lines and blank lines carry nothing. */
function settings(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .join('\n');
}

const PRE_PUSH = [
  '  piped: true',
  '  commands:',
  '    lint:',
  '      priority: 5',
  '      run: pnpm run lint',
  '    format:',
  '      priority: 2',
  '      run: pnpm run format:check',
  '    policy-fixtures:',
  '      priority: 3',
  '      run: pnpm run lint:policy-fixtures',
  '    syncpack:',
  '      priority: 1',
  '      run: pnpm exec syncpack lint',
  '    typecheck:',
  '      priority: 6',
  '      run: pnpm run typecheck',
  '    typecheck-composite:',
  '      priority: 7',
  '      run: pnpm run typecheck:tsc',
  '    test:',
  '      priority: 8',
  '      run: pnpm run test:all',
  '    coverage:',
  '      priority: 9',
  '      run: pnpm run test:coverage',
  '    build:',
  '      priority: 4',
  '      run: pnpm run build:all',
  '    pack:',
  '      priority: 10',
  '      run: pnpm run pack:check',
].join('\n');

describe('the pre-push hook', () => {
  const text = readFileSync(hooksFile, 'utf8');

  it('runs the ten gates one after another, each with its command and nothing narrowing it', () => {
    expect(settings(blockOf(text, 'pre-push'))).toBe(PRE_PUSH);
  });

  it('is read from its own block, not from the pre-commit one', () => {
    expect(settings(blockOf(text, 'pre-commit'))).toContain('test-policy:');
    expect(PRE_PUSH).not.toContain('test-policy:');
  });
});

// The pre-commit hook runs its gates one after another, the type check before lint: run side by side,
// the type check rebuilds the packages' dist while lint's typed rules read their declarations, and lint
// then reports every imported workspace type as an error type. Its manifest check matches the root
// package.json too, which `**/package.json` alone never does.
describe('the pre-commit hook', () => {
  const block = settings(blockOf(readFileSync(hooksFile, 'utf8'), 'pre-commit'));
  const priorityOf = (name: string): number => {
    const found = new RegExp(`\n    ${name}:\n(?:      .*\n)*?      priority: (\\d+)\n`).exec(
      `\n${block}\n`,
    );
    return Number(found?.[1]);
  };

  it('runs its gates one after another, the type check before lint', () => {
    expect(block).toContain('  piped: true');
    expect(block).not.toContain('parallel: true');
    expect(priorityOf('typecheck')).toBeLessThan(priorityOf('lint'));
  });

  it('checks the root manifest as well as every package one', () => {
    expect(block).toContain("glob: '{package.json,**/package.json}'");
  });
});
