import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { resolveSeccompApplyPath } from './vendor-env.js';

export interface SandboxPolicy {
  /** Write roots (cwd + $TMPDIR, plus any caller-supplied); everything else is denied. */
  readonly allowWrite: readonly string[];
  /**
   * Domain egress allowlist (empty = deny-all). Session-scoped in the runtime: the allowlist is
   * fixed at initialize, so the manager rejects any wrap whose allowEgress does not set-equal the
   * initialized session. This builder only maps it into the initialize config.
   */
  readonly allowEgress: readonly string[];
}

/** Credential / config dirs always denied for read (fail-closed policy). */
const DENY_READ = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config'] as const;

/** $XDG_DATA_HOME/minitui — the kept-app library; generated apps must never write here. */
function libraryDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'minitui');
}

/**
 * Deny-by-default ASRT config. allowWrite is exactly the caller's write roots
 * (ASRT unions its device/log defaults at wrap time); everything else is denied.
 * Egress: allow-only list + strictAllowlist so an unmatched host is denied
 * deterministically, never punted to the ask callback.
 * On Linux, threads a staged apply-seccomp (from MINITUI_ASRT_VENDOR_DIR, or its
 * execPath-sibling fallback) into seccomp.applyPath so the binary channel keeps the
 * seccomp layer ASRT would otherwise resolve from its sibling vendor/ tree; unset with
 * no execPath-sibling vendor/ found (or off-Linux) -> no seccomp key.
 * Emits every REQUIRED schema key. Pure: fresh object, never mutates policy.
 * platform/env/arch default to the real process values, overridable for deterministic tests.
 */
export function buildSandboxConfig(
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): SandboxRuntimeConfig {
  const seccompApplyPath = resolveSeccompApplyPath(platform, env, arch);
  return {
    filesystem: {
      denyRead: [...DENY_READ],
      allowWrite: [...policy.allowWrite],
      denyWrite: [libraryDir()],
    },
    network: {
      allowedDomains: [...policy.allowEgress],
      deniedDomains: [],
      strictAllowlist: true,
      allowLocalBinding: false,
    },
    ...(seccompApplyPath ? { seccomp: { applyPath: seccompApplyPath } } : {}),
  };
}
