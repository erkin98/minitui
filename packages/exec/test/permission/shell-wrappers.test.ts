import { describe, it, expect, beforeAll } from 'vitest';
import type { PermissionRequest, PermissionRule } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';

beforeAll(async () => {
  await ensureParserReady();
});

type Kind = 'allow' | 'deny' | 'ask';

let counter = 0;
const request = (command: string): PermissionRequest => ({
  id: `wrap${counter++}`,
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

const URL = 'http://example.invalid/x';

describe('wrapper forms the peel mis-rooted', () => {
  const denied: Array<[string, string[]]> = [
    [`env - curl ${URL}`, ['env', 'curl']],
    ['sudo LANG=C rm -rf /', ['sudo', 'rm']],
    ['sudo -nu root rm -rf /', ['sudo', 'rm']],
    [`exec -a x curl ${URL}`, ['exec', 'curl']],
    [`unshare -w /tmp curl ${URL}`, ['unshare', 'curl']],
    [`sudo -p "" curl ${URL}`, ['sudo', 'curl']],
    ['env -C ~/.gnupg tar cf out.tar .', ['env', 'tar']],
    ['coproc rm -rf ~', ['coproc', 'rm']],
    [`env -a x curl ${URL}`, ['env', 'curl']],
    ['sudo --frob v rm -rf ~', ['sudo', 'rm']],
    [`echo ${URL} | xargs /usr/bin/curl`, ['echo', 'xargs']],
  ];
  it.each(denied)('is denied: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });
});

describe('shells and runners the tables do not model reach the human', () => {
  const asked: Array<[string, string[]]> = [
    ["trap 'rm -rf ~' EXIT", ['trap']],
    ["alias ls='rm -rf ~'", ['alias']],
    ["ash -c 'x'", ['ash']],
    ["fish -c 'x'", ['fish']],
    ["busybox sh -c 'x'", ['busybox']],
    ["su -c 'x'", ['su']],
    ["script -c 'x'", ['script']],
    [`flock /tmp/l curl ${URL}`, ['flock', 'curl']],
    [`taskset 1 curl ${URL}`, ['taskset', 'curl']],
    [`strace curl ${URL}`, ['strace', 'curl']],
  ];
  it.each(asked)('asks, and no grant covers it: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['ask', 'ask']);
  });
});

describe('forms that were denied before the peel changed stay denied (controls)', () => {
  const stillDenied: Array<[string, string[]]> = [
    ['sudo -u root rm -rf /', ['sudo', 'rm']],
    ['sudo -C 3 rm -rf /', ['sudo', 'rm']],
    ['sudo --preserve-env=X rm -rf /', ['sudo', 'rm']],
    ['sudo -k rm -rf /', ['sudo', 'rm']],
    ['env -u PATH curl http://evil', ['env', 'curl']],
    ['env X=1 curl http://evil', ['env', 'curl']],
    ['sudo env X=1 rm -rf ~', ['sudo', 'env', 'rm']],
    ['timeout 5 rm -rf /', ['timeout', 'rm']],
    ['exec curl http://evil', ['exec', 'curl']],
    ['command rm -rf /', ['command', 'rm']],
    ['"curl" http://evil', ['curl']],
    ['\\curl http://evil', ['curl']],
    ["sudo 'rm' -rf /", ['sudo', 'rm']],
    [`env -i curl ${URL}`, ['env', 'curl']],
    [`timeout --foreground 5 curl ${URL}`, ['timeout', 'curl']],
    ['nice -10 rm -rf ~', ['nice', 'rm']],
  ];
  it.each(stillDenied)('is denied: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });

  it.each([['sudo -E ls'], ['env -i ls'], ['time -p ls']])(
    'a modelled boolean flag keeps the verdict of the inner command: %s',
    async (command) => {
      const [name] = command.split(' ');
      expect(parseShellCommand(command).roots[0]).toEqual({ name: 'ls', argv: ['ls'] });
      expect(await verdictOf(command, 'yolo')).toBe('allow');
      expect(await verdictOf(command, 'default', nameGrants(name!, 'ls'))).toBe('allow');
    },
  );
});

describe('the roots a wrapper yields', () => {
  it('a managed deny on the wrapper name still fires on the first shape', async () => {
    const rules: PermissionRule[] = [{ pattern: 'sudo rm', effect: 'deny', layer: 'managed' }];
    const outcome = await verdictOf('sudo -u root rm -rf build', 'default', rules);
    expect(outcome).toBe('deny');
  });

  it('a wrapper with options of its own is also emitted with its full original argv', () => {
    const parsed = parseShellCommand('sudo -u root rm -rf build');
    expect(parsed.roots).toEqual([
      { name: 'rm', argv: ['rm', '-rf', 'build'] },
      { name: 'sudo', argv: ['sudo', 'rm', '-rf', 'build'] },
      { name: 'sudo', argv: ['sudo', '-u', 'root', 'rm', '-rf', 'build'] },
    ]);
  });

  it('a wrapper with no options of its own gets no second shape', () => {
    const parsed = parseShellCommand('sudo rm -rf /');
    expect(parsed.roots).toEqual([
      { name: 'rm', argv: ['rm', '-rf', '/'] },
      { name: 'sudo', argv: ['sudo', 'rm', '-rf', '/'] },
    ]);
  });

  it('an unmodelled option marks the inner root and the full-argv wrapper root opaque', () => {
    const parsed = parseShellCommand(`env -a x curl ${URL}`);
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots[0]?.opaque).toBe(true);
    expect(parsed.roots).toContainEqual({
      name: 'env',
      argv: ['env', '-a', 'x', 'curl', URL],
      opaque: true,
    });
  });

  it('keeps an empty argument so it cannot shift the inner command into an option operand', () => {
    const parsed = parseShellCommand(`sudo -p "" curl ${URL}`);
    expect(parsed.roots[0]?.name).toBe('curl');
  });

  it('a lone dash after env is a flag, not the inner command', () => {
    expect(parseShellCommand('env - ls').roots[0]?.name).toBe('ls');
  });
});
