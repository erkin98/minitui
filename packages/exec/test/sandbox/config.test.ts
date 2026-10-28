import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSandboxConfig } from '../../src/sandbox/config.js';
import { grantsFilePath } from '../../src/permission/persist.js';
import { SandboxUnavailableError } from '../../src/errors.js';

/** Set one variable, or delete it for undefined (assigning undefined would store "undefined"). */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

/** Run `body` with the given variables set (undefined: unset), then restore each as it was. */
function withEnv(vars: Readonly<Record<string, string | undefined>>, body: () => void): void {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(vars)) setEnv(key, value);
  try {
    body();
  } finally {
    for (const [key, value] of saved) setEnv(key, value);
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rejection of one write root: its message starts with the fixed prefix naming that root. */
function expectWriteRootRefused(allowWrite: readonly string[], refused: string): void {
  const build = () => buildSandboxConfig({ allowWrite, allowEgress: [] });
  expect(build).toThrow(SandboxUnavailableError);
  expect(build).toThrow(
    new RegExp(
      `^${escapeRegExp(`sandbox policy rejected: write root ${JSON.stringify(refused)} `)}`,
    ),
  );
}

// The library directory rows point XDG_DATA_HOME at an absolute path outside the home directory
// (it need not exist), so the library directory is known and the home rule cannot refuse its rows.
const XDG = '/opt/minitui-test-xdg';
const LIBRARY = join(XDG, 'minitui');

describe('buildSandboxConfig', () => {
  it('denies credential and config dirs by default', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] });
    expect(cfg.filesystem.denyRead).toEqual(
      expect.arrayContaining(['~/.ssh', '~/.aws', '~/.gnupg', '~/.config']),
    );
  });

  it('allowWrite is exactly the caller roots (deny-by-default elsewhere; ASRT unions its device/log defaults at wrap time)', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work', '/tmp/x'], allowEgress: [] });
    expect(cfg.filesystem.allowWrite).toEqual(['/work', '/tmp/x']);
  });

  it('empty egress allowlist produces empty allowedDomains WITH strictAllowlist (deterministic deny-all)', () => {
    // Shape-only: strictAllowlist keeps an unmatched host from ever reaching the ask callback.
    // The live egress-deny behavior is proven in the integration gate, not this pure-builder test.
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] });
    expect(cfg.network.allowedDomains).toEqual([]);
    expect(cfg.network.strictAllowlist).toBe(true);
    expect(cfg.network.allowLocalBinding).toBe(false);
  });

  it('egress allowlist is passed through to allowedDomains', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: ['api.github.com'] });
    expect(cfg.network.allowedDomains).toEqual(['api.github.com']);
  });

  it('emits every REQUIRED schema key (deniedDomains, denyWrite)', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] });
    expect(cfg.network.deniedDomains).toEqual([]);
    expect(Array.isArray(cfg.filesystem.denyWrite)).toBe(true);
  });

  it('self-protects the minitui library dir against writes (denyWrite beats allowWrite in ASRT)', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] });
    expect(cfg.filesystem.denyWrite.some((p) => p.includes('minitui'))).toBe(true);
  });

  it('does not mutate the input policy', () => {
    const policy = { allowWrite: ['/work'], allowEgress: [] as string[] };
    const before = JSON.stringify(policy);
    buildSandboxConfig(policy);
    expect(JSON.stringify(policy)).toBe(before);
  });

  it('Linux: threads a staged apply-seccomp path from MINITUI_ASRT_VENDOR_DIR into seccomp.applyPath (binary-channel vendor-dir consumer)', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] }, 'linux', env, 'x64');
    expect(cfg.seccomp?.applyPath).toBe('/opt/minitui/vendor/seccomp/x64/apply-seccomp');
  });

  it('Linux: emits NO seccomp key when MINITUI_ASRT_VENDOR_DIR is unset (npm channel — ASRT resolves its sibling vendor/)', () => {
    const cfg = buildSandboxConfig({ allowWrite: ['/work'], allowEgress: [] }, 'linux', {}, 'x64');
    expect(cfg.seccomp).toBeUndefined();
  });

  it('win32/darwin: emits NO seccomp key even with the vendor dir set (seccomp is Linux-only)', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    expect(
      buildSandboxConfig({ allowWrite: ['/w'], allowEgress: [] }, 'win32', env, 'x64').seccomp,
    ).toBeUndefined();
    expect(
      buildSandboxConfig({ allowWrite: ['/w'], allowEgress: [] }, 'darwin', env, 'arm64').seccomp,
    ).toBeUndefined();
  });
});

describe('buildSandboxConfig policy: write roots', () => {
  it.each([
    ['the empty string', ''],
    ['a relative path', 'rel/dir'],
    ['dot', '.'],
    ['a tilde', '~'],
    ['the filesystem root', '/'],
    ['a path with a dot-dot segment', '/etc/../etc'],
    ['a trailing slash', '/work/'],
    ['the home directory', homedir()],
    ['the parent of the home directory', dirname(homedir())],
    ['a glob star', '/tmp/*'],
    ['glob brackets', '/tmp/out [1080p].mp4'],
  ])('refuses %s', (_label, root) => {
    expectWriteRootRefused([root], root);
  });

  it.each([
    ['the library directory', LIBRARY],
    ['the parent of the library directory', XDG],
    ['a path inside the library directory', join(LIBRARY, 'x')],
  ])('refuses %s', (_label, root) => {
    withEnv({ XDG_DATA_HOME: XDG }, () => expectWriteRootRefused([root], root));
  });

  // HOME is pinned too: with a home one level below the filesystem root its parent would be `/`,
  // which the library rule refuses as well, and this row would no longer isolate the home rule.
  it.each([
    ['the home directory', '/home/minitui-test-user'],
    ['the parent of the home directory', '/home'],
  ])('refuses %s by the home rule alone (library directory outside home)', (_label, root) => {
    withEnv({ HOME: '/home/minitui-test-user', XDG_DATA_HOME: XDG }, () =>
      expectWriteRootRefused([root], root),
    );
  });

  it('refuses a bad root listed beside a good one', () => {
    expectWriteRootRefused(['/work', 'rel/dir'], 'rel/dir');
  });

  it('accepts the deny-all default, an existing directory, the temp directory with an existing output file, and /tmp/mcp-fs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-root-'));
    const output = join(dir, 'out.mp4');
    writeFileSync(output, '');
    for (const allowWrite of [[], [dir], [tmpdir(), output], ['/tmp/mcp-fs']]) {
      expect(buildSandboxConfig({ allowWrite, allowEgress: [] }).filesystem.allowWrite).toEqual(
        allowWrite,
      );
    }
  });
});

describe('buildSandboxConfig policy: egress', () => {
  it.each([
    '*',
    '',
    '*.com',
    'evil.example:443',
    'http://x.example',
    'a.*.example',
    'example',
    '.example.com',
  ])('refuses the egress entry %j', (entry) => {
    expect(() => buildSandboxConfig({ allowWrite: [], allowEgress: [entry] })).toThrow(
      SandboxUnavailableError,
    );
  });

  it('accepts an exact host, localhost, a wildcard over two labels and an IPv4 literal', () => {
    const allowEgress = ['api.github.com', 'localhost', '*.github.com', '127.0.0.1'];
    expect(buildSandboxConfig({ allowWrite: [], allowEgress }).network.allowedDomains).toEqual(
      allowEgress,
    );
  });
});

describe('buildSandboxConfig deny lists come from the shared secret-path module', () => {
  const build = () => buildSandboxConfig({ allowWrite: [], allowEgress: [] });

  it('denyRead is the union of the home secret directories, the home secret files and .config', () => {
    expect(build().filesystem.denyRead).toEqual([
      '~/.ssh',
      '~/.aws',
      '~/.gnupg',
      '~/.kube',
      '~/.docker',
      '~/.azure',
      '~/.config/gh',
      '~/.netrc',
      '~/.npmrc',
      '~/.git-credentials',
      '~/.pgpass',
      '~/.pypirc',
      '~/.vault-token',
      '~/.config',
    ]);
  });

  it.each([
    ['unset', undefined],
    ['set to an absolute path', XDG],
    ['empty', ''],
  ])('the write-deny entry is the grants file directory with XDG_DATA_HOME %s', (_label, xdg) => {
    withEnv({ XDG_DATA_HOME: xdg }, () => {
      expect(build().filesystem.denyWrite).toEqual([dirname(grantsFilePath())]);
    });
  });

  it('with a relative XDG_DATA_HOME the write-deny entry is the grants file directory, under home', () => {
    withEnv({ XDG_DATA_HOME: 'rel' }, () => {
      expect(build().filesystem.denyWrite).toEqual([dirname(grantsFilePath())]);
      expect(build().filesystem.denyWrite).toEqual([join(homedir(), '.local', 'share', 'minitui')]);
    });
  });
});
