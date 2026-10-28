import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { SandboxUnavailableError } from '../errors.js';
import {
  HOME_SECRET_DIRS,
  HOME_SECRET_FILES,
  SANDBOX_ONLY_READ_DENY,
  storeDir,
} from '../permission/secret-paths.js';
import type { ExecSandboxConfig } from './platform.js';
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

/**
 * Read-denied inside the sandbox: the home secret directories and files the hard floor also uses,
 * plus `.config` (sandbox only), each spelled under `~/`.
 */
const SANDBOX_DENY_READ: readonly string[] = [
  ...HOME_SECRET_DIRS,
  ...HOME_SECRET_FILES,
  ...SANDBOX_ONLY_READ_DENY,
].map((name) => `~/${name}`);

/** A write root the policy refuses, in the one error class every caller already fails closed on. */
export function rejectWriteRoot(root: string, reason: string): never {
  throw new SandboxUnavailableError(
    `sandbox policy rejected: write root ${JSON.stringify(root)} ${reason}`,
  );
}

const GLOB_CHARS = /[*?[\]]/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** `dir` is `path` itself or one of its ancestors (both normalised absolute paths). */
function covers(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * The lexical write-root rules: normalised and absolute, no glob character (the runtime reads those
 * as globs), not the home directory or an ancestor of it, and not the library directory, an ancestor
 * of it or inside it. The filesystem root has no rule of its own: it is an ancestor of the home
 * directory. Whether the root exists needs the filesystem and is checked in the handle.
 */
function assertWriteRoot(root: string, home: string, library: string): void {
  if (resolve(root) !== root) rejectWriteRoot(root, 'is not a normalised absolute path');
  if (GLOB_CHARS.test(root)) rejectWriteRoot(root, 'contains a glob character');
  if (covers(root, home)) rejectWriteRoot(root, 'is the home directory or an ancestor of it');
  if (covers(root, library) || covers(library, root)) {
    rejectWriteRoot(root, 'is the library directory, an ancestor of it or inside it');
  }
}

/** Letter-digit-hyphen labels, at least `minLabels` of them: no scheme, port, path or wildcard. */
function isHostName(host: string, minLabels = 2): boolean {
  const labels = host.split('.');
  return labels.length >= minLabels && labels.every((label) => HOST_LABEL.test(label));
}

/**
 * An egress entry is `localhost`, an exact host name of at least two labels, or `*.` over one. The
 * rule is exec's own: `*.com` would reach every .com host through the runtime's matcher.
 */
function assertEgressEntry(entry: string): void {
  if (entry === 'localhost') return;
  if (entry.startsWith('*.') ? isHostName(entry.slice(2)) : isHostName(entry)) return;
  throw new SandboxUnavailableError(
    `sandbox policy rejected: egress entry ${JSON.stringify(entry)} is not localhost, a host name or *. followed by a host name`,
  );
}

function assertPolicy(policy: SandboxPolicy): void {
  const home = resolve(homedir());
  const library = storeDir(process.env, homedir());
  for (const root of policy.allowWrite) assertWriteRoot(root, home, library);
  for (const entry of policy.allowEgress) assertEgressEntry(entry);
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
 * Emits every REQUIRED schema key. Pure: fresh object, never mutates policy. The policy is validated
 * first: a malformed or too-wide write root or egress entry throws SandboxUnavailableError.
 * platform/env/arch default to the real process values, overridable for deterministic tests.
 */
export function buildSandboxConfig(
  policy: SandboxPolicy,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): ExecSandboxConfig {
  assertPolicy(policy);
  const seccompApplyPath = resolveSeccompApplyPath(platform, env, arch);
  return {
    filesystem: {
      denyRead: [...SANDBOX_DENY_READ],
      allowWrite: [...policy.allowWrite],
      // The program's own store, the directory of the grants file: generated apps never write here.
      denyWrite: [storeDir(process.env, homedir())],
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
