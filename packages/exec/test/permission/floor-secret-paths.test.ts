import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { PermissionRequest } from '@minitui/types';
import { createEngine } from '../../src/permission/engine.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { checkHardFloor } from '../../src/permission/hard-floor.js';
import {
  ENV_FILE_NAME,
  HOME_SECRET_DIRS,
  HOME_SECRET_FILES,
  SANDBOX_ONLY_READ_DENY,
  SECRET_FILE_NAMES,
  SECRET_SUFFIXES,
  isSecretFileName,
  storeDir,
} from '../../src/permission/secret-paths.js';

beforeAll(async () => {
  await ensureParserReady();
});

const linuxHost = {
  home: '/home/erkin',
  platform: 'linux',
  store: storeDir({}, '/home/erkin'),
} as const;

const blocked = (command: string): boolean =>
  checkHardFloor(parseShellCommand(command, linuxHost), undefined, linuxHost).blocked;

let counter = 0;
async function yoloVerdict(command: string): Promise<'allow' | 'deny' | 'ask'> {
  const request: PermissionRequest = {
    id: `sp${counter++}`,
    descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
    resolvedCommand: command,
    resolvedPaths: [],
  };
  const engine = createEngine({ initialRules: { rules: [] }, mode: 'yolo' });
  const pending = engine.check(request);
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

let savedXdg: string | undefined;
beforeEach(() => {
  savedXdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
});

describe('storeDir', () => {
  it('ignores a relative value', () => {
    expect(storeDir({ XDG_DATA_HOME: 'rel' }, '/home/u')).toBe('/home/u/.local/share/minitui');
  });
  it('uses an absolute value', () => {
    expect(storeDir({ XDG_DATA_HOME: '/x' }, '/home/u')).toBe('/x/minitui');
  });
  it('falls back to the home path when the value is empty or unset', () => {
    expect(storeDir({ XDG_DATA_HOME: '' }, '/home/u')).toBe('/home/u/.local/share/minitui');
    expect(storeDir({}, '/home/u')).toBe('/home/u/.local/share/minitui');
  });
});

describe('the store directory is a secret location for the floor', () => {
  it('denies a write and a copy under YOLO', async () => {
    expect(await yoloVerdict('echo x > ~/.local/share/minitui/grants.json')).toBe('deny');
    expect(await yoloVerdict('cp a ~/.local/share/minitui/grants.json')).toBe('deny');
  });
  it.each([
    ['echo x > ~/.local/share/minitui/grants.json'],
    ['echo x > $HOME/.local/share/minitui/grants.json'],
    ['echo x > ${HOME}/.local/share/minitui/grants.json'],
    ['echo x > /home/erkin/.local/share/minitui/grants.json'],
    ['cp a /home/erkin/.local/share/minitui/grants.json'],
    ['cat ~/.local/share/minitui/x/../grants.json'],
    ['dd of=~/.local/share/minitui/grants.json'],
    ['ls ~/.local/share/minitui'],
    ['cat ~/.local/share/other/../minitui/grants.json'],
  ])('blocks %s', (command) => {
    expect(blocked(command)).toBe(true);
  });
  // The store directory is a value of the host, not of the process environment: these rows hand the
  // floor a host whose store was derived from a variable, and write nothing to `process.env`.
  const onHost = (host: { home: string; platform: string; store: string }, command: string) =>
    checkHardFloor(parseShellCommand(command, host), undefined, host).blocked;
  it('follows an absolute store on the host', () => {
    const host = { ...linuxHost, store: storeDir({ XDG_DATA_HOME: '/x' }, linuxHost.home) };
    expect(onHost(host, 'echo x > /x/minitui/grants.json')).toBe(true);
    expect(onHost(host, 'echo x > ~/.local/share/minitui/grants.json')).toBe(false);
  });
  it('keeps the store under the home when the variable it came from was relative', () => {
    const host = { ...linuxHost, store: storeDir({ XDG_DATA_HOME: 'rel' }, linuxHost.home) };
    expect(onHost(host, 'echo x > ~/.local/share/minitui/grants.json')).toBe(true);
  });
  it('ignores the process environment: a host with the default store is floored there only', () => {
    process.env.XDG_DATA_HOME = '/elsewhere';
    const host = { ...linuxHost, store: storeDir({}, linuxHost.home) };
    expect(onHost(host, 'echo x > ~/.local/share/minitui/grants.json')).toBe(true);
    expect(onHost(host, 'echo x > /elsewhere/minitui/grants.json')).toBe(false);
  });
  it('leaves a sibling directory and the parent alone', () => {
    expect(blocked('ls ~/.local/share')).toBe(false);
    expect(blocked('ls ~/.local/share/minitui-other')).toBe(false);
    expect(blocked('ls ~/.local/share/minitui/../x')).toBe(false);
  });
  it('folds case for the store directory on a host that folds', () => {
    const darwin = {
      home: '/Users/T',
      platform: 'darwin',
      store: storeDir({}, '/Users/T'),
    } as const;
    const floor = (command: string) =>
      checkHardFloor(parseShellCommand(command, darwin), undefined, darwin).blocked;
    expect(floor('cat /users/t/.local/share/minitui/grants.json')).toBe(true);
    expect(floor('cat ~/.local/share/MINITUI/grants.json')).toBe(true);
    expect(blocked('cat /home/ERKIN/.local/share/MINITUI/grants.json')).toBe(false);
  });
});

describe('home secret locations the floor names', () => {
  it.each([
    ['cat ~/.kube/config'],
    ['cat ~/.docker/config.json'],
    ['cat ~/.azure/x'],
    ['cat ~/.config/gh/hosts.yml'],
    ['cat ~/.git-credentials'],
    ['cat ~/.netrc'],
    ['cat ~/.npmrc'],
    ['cat ~/.gnupg/x'],
    ['cat ~/.net*'],
    ['dd if=.netrc of=/tmp/x'],
    ['cat ~/.confi?/gh/hosts.yml'],
    ['cat ~/.config/g*/hosts.yml'],
  ])('blocks %s', (command) => {
    expect(blocked(command)).toBe(true);
  });
  it.each([
    ['ls ~/.config'],
    ['cat ~/.config/foo'],
    ['ls ~/.con*'],
    ['cat ~/.confi?/other'],
    ['ls ~/.config/*'],
  ])('does not block %s (the config directory is a sandbox-only read deny)', (command) => {
    expect(blocked(command)).toBe(false);
  });
});

describe('secret locations on a host that folds case', () => {
  const darwin = {
    home: '/Users/t',
    platform: 'darwin',
    store: storeDir({}, '/Users/t'),
  } as const;
  const onDarwin = (command: string) =>
    checkHardFloor(parseShellCommand(command, darwin), undefined, darwin).blocked;
  it.each([
    ['cat ~/.SSH/config'],
    ['cat ~/.Config/GH/hosts.yml'],
    ['cat ~/.GIT-Credentials'],
    ['cat ~/.NetRC'],
    ['cat ~/ID_RSA'],
    ['cat ~/.ENV.Local'],
    ['cat x.PEM'],
    ['dd if=.ENV of=/tmp/x'],
    ['cat $HOME/.SSH/config'],
    ['cat ~/.SS?/known_hosts'],
    ['cat ~/.\u017fsh/config'],
    ['cat ~/.\u017fs?/config'],
    ['cat ~/.\u212aube/config'],
  ])('blocks %s on darwin', (command) => {
    expect(onDarwin(command)).toBe(true);
  });
  it('keeps the case-sensitive verdict on a host that does not fold', () => {
    expect(blocked('cat ~/.SSH/config')).toBe(false);
    expect(blocked('cat x.PEM')).toBe(false);
    expect(blocked('cat ~/.\u017fsh/config')).toBe(false);
  });
});

describe('the lists', () => {
  it('names the home directories', () => {
    expect([...HOME_SECRET_DIRS]).toEqual([
      '.ssh',
      '.aws',
      '.gnupg',
      '.kube',
      '.docker',
      '.azure',
      '.config/gh',
    ]);
  });
  it('names the home files', () => {
    expect([...HOME_SECRET_FILES]).toEqual([
      '.netrc',
      '.npmrc',
      '.git-credentials',
      '.pgpass',
      '.pypirc',
      '.vault-token',
    ]);
  });
  it('names the secret file names, the env name and the secret endings', () => {
    expect([...SECRET_FILE_NAMES]).toEqual([
      'id_rsa',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
      'credentials',
    ]);
    expect(ENV_FILE_NAME).toBe('.env');
    expect([...SECRET_SUFFIXES]).toEqual(['.pem', '.p12', '.pfx', '.key']);
  });
  it('names the sandbox-only read deny', () => {
    expect([...SANDBOX_ONLY_READ_DENY]).toEqual(['.config']);
  });
  it.each([
    ['id_rsa'],
    ['id_ed25519'],
    ['id_ecdsa'],
    ['id_dsa'],
    ['.env'],
    ['.env.local'],
    ['credentials'],
    ['x.pem'],
    ['x.p12'],
    ['x.pfx'],
    ['x.key'],
    ['if=id_rsa'],
    ['a=b=.env'],
  ])('a secret file name matches %s', (name) => {
    expect(isSecretFileName(name)).toBe(true);
  });
  it.each([
    ['id_rsa.pub.txt'],
    ['id_ecdsa.pub'],
    ['environment'],
    ['.envx'],
    ['credentials.json'],
    ['pem'],
    ['x.keys'],
    ['x.pemx'],
  ])('no secret file name matches %s', (name) => {
    expect(isSecretFileName(name)).toBe(false);
  });
});

describe('basename secrets keep their verdicts', () => {
  it.each([
    ['cat id_rsa'],
    ['cat a/id_ed25519'],
    ['cat .env'],
    ['cat x/.env.local'],
    ['cat ~/credentials'],
    ['cat k/x.pem'],
    ['dd if=.env of=/tmp/x'],
    ['cat ~/id_rs?'],
    ['cat ~/.en?'],
    ['cat ~/credential?'],
    ['cat ~/id_ed2551?'],
  ])('blocks %s', (command) => {
    expect(blocked(command)).toBe(true);
  });
  it.each([['cat environment'], ['cat credentials.json'], ['cat a.pemx']])(
    'does not block %s',
    (command) => {
      expect(blocked(command)).toBe(false);
    },
  );
});

// The same command in default mode with a grant for its command word: the grant lifts an ask, never the floor.
async function grantedVerdict(command: string, word: string): Promise<'allow' | 'deny' | 'ask'> {
  const request: PermissionRequest = {
    id: `sg${counter++}`,
    descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
    resolvedCommand: command,
    resolvedPaths: [],
  };
  const engine = createEngine({
    initialRules: { rules: [{ pattern: word, effect: 'allow', layer: 'user' }] },
    mode: 'default',
  });
  const pending = engine.check(request);
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

describe('more secret file names are floored in every mode', () => {
  it.each([
    ['cat /tmp/x/id_ecdsa'],
    ['cat /tmp/x/id_dsa'],
    ['cat /tmp/x/server.p12'],
    ['cat /tmp/x/a.pfx'],
    ['cat /tmp/x/tls.key'],
    ['cat ~/.pgpass'],
    ['cat ~/.pypirc'],
    ['cat ~/.vault-token'],
  ])('denies %s under YOLO and under a grant for cat', async (command) => {
    expect(await yoloVerdict(command)).toBe('deny');
    expect(await grantedVerdict(command, 'cat')).toBe('deny');
  });
  it('reads a name attached to an assignment, and refuses nothing it did not name before', () => {
    expect(blocked('dd if=id_rsa of=/tmp/x')).toBe(true);
    expect(blocked('cat a=b=.env')).toBe(true);
    expect(blocked('cat id_ecdsa.pub')).toBe(false);
    expect(blocked('cat x.keys')).toBe(false);
    expect(blocked('cat .envx')).toBe(false);
  });
  it('lets a command with no secret name through under a grant (control)', async () => {
    expect(await grantedVerdict('cat notes.txt', 'cat')).toBe('allow');
  });
});
