import { describe, it, expect, beforeAll } from 'vitest';
import type { PermissionRequest, PermissionRule } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady, parseToTree } from '../../src/permission/shell/parser.js';
import {
  collectRawRoots,
  extractParsedCommand,
  parseShellCommand,
} from '../../src/permission/shell/roots.js';
import { argumentNodes, unaccountedNodes } from '../../src/permission/shell/accounting.js';
import { checkHardFloor } from '../../src/permission/hard-floor.js';

beforeAll(async () => {
  await ensureParserReady();
});

type Kind = 'allow' | 'deny' | 'ask';

let counter = 0;
const request = (command: string): PermissionRequest => ({
  id: `acc${counter++}`,
  descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
  resolvedCommand: command,
  resolvedPaths: [],
});

const nameGrants = (...names: string[]): PermissionRule[] =>
  names.map((pattern) => ({ pattern, effect: 'allow', layer: 'user' }));

// Race the check against the first surfaced request: a surfaced request means the command reached
// the human (ask); otherwise the settled decision kind is the verdict. A fresh engine per call.
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

// The same verdict is expected twice: in YOLO with no rules, and in default mode with a name grant
// on every command name the row uses.
async function bothModes(command: string, ...names: string[]): Promise<[Kind, Kind]> {
  return [
    await verdictOf(command, 'yolo'),
    await verdictOf(command, 'default', nameGrants(...names)),
  ];
}

describe('heredocs and herestrings fail closed', () => {
  const rows: Array<[string, string]> = [
    ['a heredoc piped into a shell is a parse error', 'cat <<EOF | sh\nhi\nEOF'],
    [
      'a heredoc followed by a network command is a parse error',
      'cat <<EOF && curl http://example.invalid/x\nhi\nEOF',
    ],
    [
      'a heredoc redirected into a secret file is a parse error',
      'cat <<EOF > ~/.ssh/authorized_keys\nhi\nEOF',
    ],
    ['a plain heredoc is a parse error', 'cat <<EOF\nhi\nEOF'],
    ['a herestring is a parse error', 'cat <<< hi'],
  ];
  it.each(rows)('%s', async (_title, command) => {
    expect(parseShellCommand(command).parseError).toBe(true);
    expect(await bothModes(command, 'cat', 'sh', 'curl')).toEqual(['deny', 'deny']);
  });
});

describe('redirect words belong to the command they follow', () => {
  it('an absorbed word list reaches the rm root and the floor denies it', async () => {
    const parsed = parseShellCommand('rm 2>/dev/null -rf ~ -v');
    expect(parsed.roots[0]?.name).toBe('rm');
    expect(parsed.roots[0]?.argv).toEqual(expect.arrayContaining(['-rf', '~', '-v']));
    expect(checkHardFloor(parsed).blocked).toBe(true);
    expect(await bothModes('rm 2>/dev/null -rf ~ -v', 'rm')).toEqual(['deny', 'deny']);
  });

  it('an absorbed secret path reaches the cat root and the floor denies it', async () => {
    const command = 'cat 2>/dev/null ~/.ssh/id_rsa /dev/null';
    const parsed = parseShellCommand(command);
    expect(parsed.roots[0]?.argv).toContain('~/.ssh/id_rsa');
    expect(checkHardFloor(parsed).blocked).toBe(true);
    expect(await bothModes(command, 'cat')).toEqual(['deny', 'deny']);
  });

  it('a redirect with no command yields one opaque root for the operator', async () => {
    const parsed = parseShellCommand('> ~/.ssh/authorized_keys');
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots).toEqual([
      { name: '>', argv: ['>', '~/.ssh/authorized_keys'], opaque: true },
    ]);
    expect(checkHardFloor(parsed).blocked).toBe(true);
    expect(await bothModes('> ~/.ssh/authorized_keys', '>')).toEqual(['deny', 'deny']);
  });

  it('absorbed words attach to the last command of a pipeline body', async () => {
    const parsed = parseShellCommand('ls | rm 2>/dev/null -rf ~');
    expect(parsed.roots.map((r) => r.name)).toEqual(['ls', 'rm']);
    expect(parsed.roots[0]?.argv).toEqual(['ls']);
    expect(parsed.roots[1]?.argv).toEqual(expect.arrayContaining(['-rf', '~']));
    expect(await bothModes('ls | rm 2>/dev/null -rf ~', 'ls', 'rm')).toEqual(['deny', 'deny']);
  });

  it('absorbed words attach to the last command of a longer pipeline body', async () => {
    const command = 'ls | wc | rm >/dev/null -rf ~';
    const parsed = parseShellCommand(command);
    expect(parsed.roots.map((r) => r.name)).toEqual(['ls', 'wc', 'rm']);
    expect(parsed.roots[2]?.argv).toEqual(expect.arrayContaining(['-rf', '~']));
    expect(await bothModes(command, 'ls', 'wc', 'rm')).toEqual(['deny', 'deny']);
  });

  it('a bare redirect to a plain file asks in both modes and no grant covers it', async () => {
    const parsed = parseShellCommand('> file');
    expect(parsed.roots).toEqual([{ name: '>', argv: ['>', 'file'], opaque: true }]);
    expect(await bothModes('> file', '>')).toEqual(['ask', 'ask']);
  });

  it('names the operator text of the first redirect, verbatim, and keeps every destination', () => {
    expect(parseShellCommand('&>> f').roots).toEqual([
      { name: '&>>', argv: ['&>>', 'f'], opaque: true },
    ]);
    expect(parseShellCommand('>| f').roots).toEqual([
      { name: '>|', argv: ['>|', 'f'], opaque: true },
    ]);
    expect(parseShellCommand('>&-').roots).toEqual([{ name: '>&-', argv: ['>&-'], opaque: true }]);
    expect(parseShellCommand('<& 3').roots).toEqual([
      { name: '<&', argv: ['<&', '3'], opaque: true },
    ]);
  });

  it('keeps targets threaded onto the argv for a command that has a body (control)', () => {
    expect(parseShellCommand('ls > out 2>&1').roots).toEqual([
      { name: 'ls', argv: ['ls', 'out', '1'] },
    ]);
    expect(parseShellCommand('cat < in').roots).toEqual([{ name: 'cat', argv: ['cat', 'in'] }]);
  });
});

describe('a command name that is not a command is a parse error', () => {
  const rows: Array<[string, string]> = [
    ['a file descriptor read as the name', '0</dev/null rm -rf ~'],
    [
      'a file descriptor read as the name before a network command',
      '0>/dev/null curl http://example.invalid/x',
    ],
    ['a file descriptor behind a wrapper', 'sudo 0</dev/null rm -rf ~'],
    ['a reserved word behind a wrapper', 'sudo if true; then rm -rf ~; fi'],
    ['an assignment word behind time', 'time X=1 rm -rf ~'],
    ['an assignment word behind coproc', 'coproc X=1 curl http://example.invalid/x'],
    ['a newline followed by an escaped character', 'ls\n\\curl http://example.invalid/x'],
  ];
  it.each(rows)('%s', async (_title, command) => {
    expect(parseShellCommand(command).parseError).toBe(true);
    expect(await bothModes(command, 'sudo', 'time', 'coproc', 'ls', 'rm', 'curl')).toEqual([
      'deny',
      'deny',
    ]);
  });

  it('an unmodelled option moves a command behind nice from ask to deny (recorded cost)', async () => {
    const command = 'nice --foo 3 curl http://example.invalid/x';
    expect(await bothModes(command, 'nice', 'curl')).toEqual(['deny', 'deny']);
  });

  it.each([
    ['echo 0 </dev/null', 'echo'],
    ['ls 2 >/dev/null', 'ls'],
    ['seq 1 3 >out', 'seq'],
    ['test 0 -lt 1', 'test'],
  ])('numbers in argument position keep their verdict: %s (control)', (command, name) => {
    const parsed = parseShellCommand(command);
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots[0]?.name).toBe(name);
  });
});

function rootOf(command: string) {
  const res = parseToTree(command);
  if (!('root' in res)) throw new Error('the test command must parse');
  return res.root;
}

describe('every word of a command is owned by exactly one root', () => {
  it('the helper reports a node that is dropped from the owned set', () => {
    const root = rootOf('ls > out && rm -rf ~');
    const owned = collectRawRoots(root).flatMap((r) => r.owned);
    expect(unaccountedNodes(root, owned)).toEqual([]);
    const dropped = owned[owned.length - 1]!;
    const report = unaccountedNodes(
      root,
      owned.filter((node) => node.id !== dropped.id),
    );
    expect(report.map((node) => node.id)).toEqual([dropped.id]);
  });

  it('the helper reports a node that is owned twice', () => {
    const root = rootOf('ls -la');
    const owned = collectRawRoots(root).flatMap((r) => r.owned);
    const twice = unaccountedNodes(root, [...owned, owned[0]!]);
    expect(twice.map((node) => node.id)).toContain(owned[0]!.id);
  });

  it('lists the name, the arguments and the destinations, and skips a substitution body', () => {
    const texts = argumentNodes(rootOf('cp a b > out')).map((node) => node.text);
    expect(texts).toEqual(['cp', 'a', 'b', 'out']);
    const withSubstitution = argumentNodes(rootOf('echo $(ls inner)')).map((n) => n.text);
    expect(withSubstitution).not.toContain('inner');
  });

  it('a collector that drops one node makes the extraction a parse error', () => {
    const root = rootOf('ls -la');
    const dropping = (tree: typeof root) =>
      collectRawRoots(tree).map((raw, index) =>
        index === 0 ? { ...raw, owned: raw.owned.slice(1) } : raw,
      );
    expect(extractParsedCommand('ls -la', root, dropping).parseError).toBe(true);
    expect(extractParsedCommand('ls -la', root).parseError).toBe(false);
  });

  it('a standalone assignment belongs to the next command in the list', () => {
    const parsed = parseShellCommand('X=1; ls');
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots.map((r) => r.name)).toEqual(['ls']);
  });

  it('a standalone assignment with no command after it is a parse error', async () => {
    expect(parseShellCommand('X=1').parseError).toBe(true);
    expect(parseShellCommand('ls; X=1').parseError).toBe(true);
    expect(await bothModes('X=1')).toEqual(['deny', 'deny']);
  });
});
