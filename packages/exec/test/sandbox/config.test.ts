import { describe, it, expect } from 'vitest';
import { buildSandboxConfig } from '../../src/sandbox/config.js';

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

  it('win32/darwin: emits NO seccomp key even with the vendor dir set (seccomp is Linux-only; win32 uses the SRT_WIN_PATH env hook)', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    expect(
      buildSandboxConfig({ allowWrite: ['/w'], allowEgress: [] }, 'win32', env, 'x64').seccomp,
    ).toBeUndefined();
    expect(
      buildSandboxConfig({ allowWrite: ['/w'], allowEgress: [] }, 'darwin', env, 'arm64').seccomp,
    ).toBeUndefined();
  });
});
