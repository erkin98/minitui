import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { unwrapArgv } from '../../src/permission/shell/wrappers.js';
import { checkHardFloor } from '../../src/permission/hard-floor.js';

beforeAll(async () => {
  await ensureParserReady();
});

// Each list is written out here and never imported from the source, so a name silently dropped from the
// source set turns its row red.

const host = { home: '/home/erkin', platform: 'linux' } as const;

const blockedByFloor = (command: string): boolean =>
  checkHardFloor(parseShellCommand(command, host), undefined, host).blocked;

describe('every shell and command-string builtin is an opaque spawner', () => {
  const spawners = [
    'sh',
    'bash',
    'dash',
    'ksh',
    'zsh',
    'eval',
    'source',
    '.',
    'ash',
    'fish',
    'csh',
    'tcsh',
    'busybox',
    'su',
    'script',
    'hash',
    'trap',
    'alias',
    'flock',
    'taskset',
    'chrt',
    'nsenter',
    'runuser',
    'setpriv',
    'fakeroot',
    'proxychains',
    'proxychains4',
    'strace',
    'ltrace',
    'watch',
    'systemd-run',
    'parallel',
  ];
  it.each(spawners)('%s is opaque and not peeled', (name) => {
    const result = unwrapArgv([name, 'x']);
    expect(result.name).toBe(name);
    expect(result.opaque).toBe(true);
    expect(result.wrappedBy).toEqual([]);
  });
});

describe('every argument runner is peeled to its inner command', () => {
  // the operands a runner takes before the inner command
  const runners: Array<[string, string[]]> = [
    ['env', []],
    ['sudo', []],
    ['doas', []],
    ['timeout', ['5']],
    ['nice', []],
    ['nohup', []],
    ['setsid', []],
    ['stdbuf', []],
    ['time', []],
    ['ionice', []],
    ['chroot', ['/new']],
    ['unshare', []],
    ['npx', []],
    ['docker', []],
    ['exec', []],
    ['command', []],
    ['builtin', []],
    ['coproc', []],
  ];
  it.each(runners)('%s is listed in wrappedBy', (name, operands) => {
    const result = unwrapArgv([name, ...operands, 'ls']);
    expect(result.name).toBe('ls');
    expect(result.wrappedBy).toEqual([name]);
    expect(result.opaque).toBe(false);
  });
});

describe('every secret location is blocked by the floor', () => {
  const secrets = [
    '~/.ssh/known_hosts',
    '~/.aws/config',
    '~/.gnupg/pubring.kbx',
    '~/id_rsa',
    '~/id_ed25519',
    '~/.env',
    '~/.env.local',
    '~/.netrc',
    '~/.npmrc',
    '~/credentials',
    '~/x.pem',
  ];
  it.each(secrets)('cat %s', (path) => {
    expect(blockedByFloor(`cat ${path}`)).toBe(true);
  });
});

describe('both network devices are blocked by the floor', () => {
  it.each([['/dev/tcp/h/1'], ['/dev/udp/h/1']])('cat x > %s', (device) => {
    expect(blockedByFloor(`cat x > ${device}`)).toBe(true);
  });
});
