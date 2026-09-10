import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAsrtVendorEnv, resolveSeccompApplyPath } from '../../src/sandbox/vendor-env.js';

const stageVendor = (): string => mkdtempSync(join(tmpdir(), 'asrt-vendor-'));

describe('applyAsrtVendorEnv (MINITUI_ASRT_VENDOR_DIR consumer)', () => {
  it('win32: maps a vendor-tree srt-win.exe (vendor/srt-win/{arch}/) to SRT_WIN_PATH', () => {
    const dir = stageVendor();
    mkdirSync(join(dir, 'srt-win', 'x64'), { recursive: true });
    const exe = join(dir, 'srt-win', 'x64', 'srt-win.exe');
    writeFileSync(exe, '');
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: dir };
    applyAsrtVendorEnv('win32', env, 'x64');
    expect(env.SRT_WIN_PATH).toBe(exe);
  });

  it('win32: honors a flat srt-win.exe staged directly under the vendor dir', () => {
    const dir = stageVendor();
    const exe = join(dir, 'srt-win.exe');
    writeFileSync(exe, '');
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: dir };
    applyAsrtVendorEnv('win32', env, 'arm64');
    expect(env.SRT_WIN_PATH).toBe(exe);
  });

  it('win32: NEVER overwrites an explicit SRT_WIN_PATH the caller already set', () => {
    const dir = stageVendor();
    writeFileSync(join(dir, 'srt-win.exe'), '');
    const env: NodeJS.ProcessEnv = {
      MINITUI_ASRT_VENDOR_DIR: dir,
      SRT_WIN_PATH: '/explicit/srt-win.exe',
    };
    applyAsrtVendorEnv('win32', env, 'x64');
    expect(env.SRT_WIN_PATH).toBe('/explicit/srt-win.exe');
  });

  it('win32: leaves SRT_WIN_PATH unset when the vendor dir has no srt-win.exe (runtime own resolution + fail-closed probe take over)', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: stageVendor() };
    applyAsrtVendorEnv('win32', env, 'x64');
    expect(env.SRT_WIN_PATH).toBeUndefined();
  });

  it('linux: applyAsrtVendorEnv sets no env hook (the Linux seccomp consumer is the config-path resolveSeccompApplyPath, not an env var)', () => {
    const dir = stageVendor();
    writeFileSync(join(dir, 'srt-win.exe'), '');
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: dir };
    applyAsrtVendorEnv('linux', env, 'x64');
    expect(env.SRT_WIN_PATH).toBeUndefined();
  });

  it('win32: no-op when MINITUI_ASRT_VENDOR_DIR is unset and no execPath-sibling vendor/ exists', () => {
    const env: NodeJS.ProcessEnv = {};
    const execPath = join(stageVendor(), 'minitui.exe'); // fresh empty dir — no vendor/ sibling
    applyAsrtVendorEnv('win32', env, 'x64', execPath);
    expect(env.SRT_WIN_PATH).toBeUndefined();
  });

  it('win32: execPath-sibling vendor/srt-win/{arch}/srt-win.exe resolves when MINITUI_ASRT_VENDOR_DIR is unset (curl|sh channel)', () => {
    const installDir = stageVendor();
    mkdirSync(join(installDir, 'vendor', 'srt-win', 'x64'), { recursive: true });
    const exe = join(installDir, 'vendor', 'srt-win', 'x64', 'srt-win.exe');
    writeFileSync(exe, '');
    const execPath = join(installDir, 'minitui.exe');
    const env: NodeJS.ProcessEnv = {};
    applyAsrtVendorEnv('win32', env, 'x64', execPath);
    expect(env.SRT_WIN_PATH).toBe(exe);
  });
});

describe('resolveSeccompApplyPath (Linux seccomp.applyPath consumer)', () => {
  it('linux: resolves <dir>/seccomp/<arch>/apply-seccomp from MINITUI_ASRT_VENDOR_DIR', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    expect(resolveSeccompApplyPath('linux', env, 'x64')).toBe(
      '/opt/minitui/vendor/seccomp/x64/apply-seccomp',
    );
    expect(resolveSeccompApplyPath('linux', env, 'arm64')).toBe(
      '/opt/minitui/vendor/seccomp/arm64/apply-seccomp',
    );
  });

  it('linux: undefined when MINITUI_ASRT_VENDOR_DIR is unset and no execPath-sibling vendor/ exists (npm channel resolves its sibling vendor/)', () => {
    const execPath = join(stageVendor(), 'minitui'); // fresh empty dir — no vendor/ sibling
    expect(resolveSeccompApplyPath('linux', {}, 'x64', execPath)).toBeUndefined();
  });

  it('linux: execPath-sibling vendor/seccomp/{arch}/apply-seccomp resolves when MINITUI_ASRT_VENDOR_DIR is unset (curl|sh channel)', () => {
    const installDir = stageVendor();
    mkdirSync(join(installDir, 'vendor', 'seccomp', 'x64'), { recursive: true });
    const helper = join(installDir, 'vendor', 'seccomp', 'x64', 'apply-seccomp');
    writeFileSync(helper, '');
    const execPath = join(installDir, 'minitui');
    expect(resolveSeccompApplyPath('linux', {}, 'x64', execPath)).toBe(helper);
  });

  it('linux: undefined for an unmapped arch', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    expect(resolveSeccompApplyPath('linux', env, 'ppc64')).toBeUndefined();
  });

  it('non-Linux: undefined (win32 uses SRT_WIN_PATH; darwin has no seccomp)', () => {
    const env: NodeJS.ProcessEnv = { MINITUI_ASRT_VENDOR_DIR: '/opt/minitui/vendor' };
    expect(resolveSeccompApplyPath('win32', env, 'x64')).toBeUndefined();
    expect(resolveSeccompApplyPath('darwin', env, 'arm64')).toBeUndefined();
  });
});
