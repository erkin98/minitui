import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The pre-push hook is the last local gate before a push, and a feature branch has no other check.
// These rows pin its commands, their order and what each one runs, read from the pre-push block alone:
// the pre-commit block runs some of the same commands, and a match anywhere in the file would let a
// deleted pre-push command go unnoticed.
const hooksFile = fileURLToPath(new URL('../../lefthook.yml', import.meta.url));

/** The text of one top-level block of the hooks file, up to the next top-level key. */
export function blockOf(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) throw new Error(`the hooks file has no ${name} block`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

interface HookCommand {
  readonly name: string;
  readonly priority: number;
  readonly run: string;
}

/** The commands of a block: each name with its priority and its run line. */
export function commandsOf(block: string): readonly HookCommand[] {
  const commands: HookCommand[] = [];
  let current: { name: string; priority?: number; run?: string } | undefined;
  const flush = (): void => {
    if (current?.priority !== undefined && current.run !== undefined) {
      commands.push({ name: current.name, priority: current.priority, run: current.run });
    }
  };
  for (const line of block.split('\n')) {
    const name = /^ {4}([a-z][a-z-]*):$/.exec(line)?.[1];
    if (name !== undefined) {
      flush();
      current = { name };
      continue;
    }
    const priority = /^ {6}priority: (\d+)$/.exec(line)?.[1];
    if (priority !== undefined && current !== undefined) current.priority = Number(priority);
    const run = /^ {6}run: (.+)$/.exec(line)?.[1];
    if (run !== undefined && current !== undefined) current.run = run;
  }
  flush();
  return [...commands].sort((a, b) => a.priority - b.priority);
}

const PRE_PUSH: readonly HookCommand[] = [
  { name: 'syncpack', priority: 1, run: 'pnpm exec syncpack lint' },
  { name: 'format', priority: 2, run: 'pnpm run format:check' },
  { name: 'policy-fixtures', priority: 3, run: 'pnpm run lint:policy-fixtures' },
  { name: 'build', priority: 4, run: 'pnpm run build:all' },
  { name: 'lint', priority: 5, run: 'pnpm run lint' },
  { name: 'typecheck', priority: 6, run: 'pnpm run typecheck' },
  { name: 'typecheck-composite', priority: 7, run: 'pnpm run typecheck:tsc' },
  { name: 'test', priority: 8, run: 'pnpm run test:all' },
  { name: 'coverage', priority: 9, run: 'pnpm run test:coverage' },
  { name: 'pack', priority: 10, run: 'pnpm run pack:check' },
];

describe('the pre-push hook', () => {
  const block = blockOf(readFileSync(hooksFile, 'utf8'), 'pre-push');

  it('runs its commands one after another and stops at the first failure', () => {
    expect(block).toMatch(/^ {2}piped: true$/m);
  });

  it('runs the ten gates in their order, each with its own command', () => {
    expect(commandsOf(block)).toEqual(PRE_PUSH);
  });

  it('reads the pre-push block alone, not a command of another hook', () => {
    // Delete the whole pre-push lint entry (its comment lines included): it must drop out of the list.
    const withoutLint = block.replace(/^ {4}lint:\n(?: {6}.*\n)*/m, '');
    expect(withoutLint).not.toBe(block);
    expect(commandsOf(withoutLint).map((command) => command.name)).not.toContain('lint');
  });
});
