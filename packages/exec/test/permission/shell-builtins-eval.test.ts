import { describe, it, expect, beforeAll } from 'vitest';
import type { PermissionRequest, PermissionRule } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';

beforeAll(async () => {
  await ensureParserReady();
});

// Some shell builtins evaluate a quoted operand as an array subscript or as a command string, and a
// `$(...)` inside a single-quoted string is plain text to the grammar, so the host cannot see the
// command it hides. Those builtins ask in every mode, as any root the host cannot account for does.
// The payloads here are benign: the verdict does not depend on what the quoted text holds.
// Bash 5.2.21 was used to confirm which builtins run the text. `[` and `[[` already fail to parse
// (the test command and the `[` builtin are not modelled), so they are not in the set.

let counter = 0;
const request = (command: string): PermissionRequest => ({
  id: `be${counter++}`,
  descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
  resolvedCommand: command,
  resolvedPaths: [],
});

type Kind = 'allow' | 'deny' | 'ask';

async function verdictOf(
  command: string,
  mode: 'yolo' | 'default',
  rules: PermissionRule[] = [],
): Promise<Kind> {
  const engine = createEngine({ initialRules: { rules }, mode });
  const pending = engine.check(request(command));
  const iter = engine.requests[Symbol.asyncIterator]();
  const first = await Promise.race([
    pending.then((d) => ({ asked: false as const, kind: d.kind })),
    iter.next().then(() => ({ asked: true as const, kind: 'ask' as const })),
  ]);
  if (first.asked) {
    engine.disposeAll('drain');
    await pending.catch(() => {});
  }
  return first.kind;
}

// YOLO with no rules, and default mode with a grant for each command word.
async function bothModes(command: string, ...words: string[]): Promise<[Kind, Kind]> {
  const grants: PermissionRule[] = words.map((pattern) => ({
    pattern,
    effect: 'allow',
    layer: 'user',
  }));
  return [await verdictOf(command, 'yolo'), await verdictOf(command, 'default', grants)];
}

describe('builtins that evaluate a quoted operand ask in every mode', () => {
  it.each([
    ["printf -v 'a[$(id)]' x", 'printf'],
    ["let 'a[$(id)]=1'", 'let'],
    ["test -v 'a[$(id)]'", 'test'],
    ["read -a 'a[$(id)]'", 'read'],
    ["read -ra 'a[$(id)]'", 'read'],
    ["mapfile -C 'id' -c 1 a", 'mapfile'],
    ["readarray -C 'id' -c 1 a", 'readarray'],
    ["read 'a[$(id)]'", 'read'],
    ["compgen -W '$(id)'", 'compgen'],
    ["compgen -C 'id' x", 'compgen'],
  ])('asks for %s', async (command, word) => {
    expect(await bothModes(command, word)).toEqual(['ask', 'ask']);
    expect(parseShellCommand(command).roots[0]?.opaque).toBe(true);
  });

  // The option's operand may be written attached to it (`-v'a[...]'`, `-C'cmd'`): bash runs it too.
  it.each([
    ["printf -v'a[$(id)]' x", 'printf'],
    ["mapfile -C'rm -rf ~' -c 1 a", 'mapfile'],
    ['readarray -Cid -c1 a', 'readarray'],
    ["read -ra'x[$(id)]'", 'read'],
  ])('asks for an attached operand: %s', async (command, word) => {
    expect(await bothModes(command, word)).toEqual(['ask', 'ask']);
  });

  // A declaration builtin written plainly is refused by the grammar (a parse error), but `builtin` and
  // `command` peel to it as an ordinary command, and bash evaluates a subscript in its operand.
  it.each([
    ["builtin declare 'a[$(id)]'=1", 'builtin'],
    ["builtin typeset 'a[$(id)]'=1", 'builtin'],
    ["builtin readonly 'a[$(id)]'=1", 'builtin'],
    ["builtin export 'a[$(id)]'", 'builtin'],
    ["builtin unset 'a[$(id)]'", 'builtin'],
    ["command declare 'a[$(id)]'=1", 'command'],
  ])('asks for a declaration builtin reached through a wrapper: %s', async (command, word) => {
    expect(await bothModes(command, word)).toEqual(['ask', 'ask']);
    expect(parseShellCommand(command).roots[0]?.opaque).toBe(true);
  });

  it('asks for a bare let, which takes no option', async () => {
    expect(await bothModes('let', 'let')).toEqual(['ask', 'ask']);
  });

  // Controls: forms with no quoted evaluation keep the verdict they had.
  it.each([
    ['test file -eq 1', 'test'],
    ["printf '%s\\n' hi", 'printf'],
    ['read x', 'read'],
    ['read -r line', 'read'],
    ['echo hello', 'echo'],
    ['mapfile -t lines', 'mapfile'],
  ])('keeps the verdict of %s', async (command, word) => {
    expect(await bothModes(command, word)).toEqual(['allow', 'allow']);
    expect(parseShellCommand(command).roots[0]?.opaque).toBeUndefined();
  });

  // a wrapper in front of an ordinary command changes nothing
  it.each([
    ['builtin echo hello', ['builtin', 'echo']],
    ['command ls', ['command', 'ls']],
  ] as const)('keeps the verdict of %s', async (command, words) => {
    expect(await bothModes(command, ...words)).toEqual(['allow', 'allow']);
    expect(parseShellCommand(command).roots[0]?.opaque).toBeUndefined();
  });
});
