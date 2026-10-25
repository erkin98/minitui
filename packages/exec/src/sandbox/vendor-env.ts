import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The env var minitui's binary-channel launcher sets to the directory where it stages the sandbox
 * runtime's platform helper binaries. A single-binary (SEA) install has no node_modules for the
 * runtime to resolve its own `vendor/` helper tree from, so without honoring this the sandbox fails
 * closed on missing helpers and ALL gated exec is dead.
 */
const VENDOR_DIR_ENV = 'MINITUI_ASRT_VENDOR_DIR';

/** Node process.arch → the runtime's vendor arch dir name (only x64 and arm64 ship helpers). */
function vendorArch(arch: string): string | undefined {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return undefined;
}

/**
 * Thread MINITUI_ASRT_VENDOR_DIR (or its execPath-sibling fallback) into the ONE env hook the
 * sandbox runtime actually reads.
 *
 *  - win32: the runtime's srt-win path resolver reads process.env.SRT_WIN_PATH FIRST and returns it
 *    when the file exists — a real, honored override. We resolve `srt-win.exe` under the resolved
 *    vendor dir (tree or flat layout) and set SRT_WIN_PATH.
 *  - linux: the runtime exposes NO seccomp env hook (its seccomp helper walk is module-location
 *    relative only), so this env shim is a no-op on posix. The Linux binary-channel consumer is the
 *    sibling resolveSeccompApplyPath below: it feeds the staged apply-seccomp path into the
 *    runtime's seccomp.applyPath config field (threaded at initialize — the explicit-path parameter
 *    the resolver checks first). macOS uses seatbelt (no seccomp), so it too is a no-op.
 *
 * Vendor-dir resolution order: the explicit MINITUI_ASRT_VENDOR_DIR when set, else an
 * execPath-sibling `vendor/` dir (dirname(execPath)+'/vendor') — the layout a curl-piped install
 * stages next to the binary with no launcher and nothing to set the env var. The fallback only
 * engages when the env var is ABSENT (never redirects away from an explicitly-set-but-wrong dir),
 * and like the explicit case is existence-gated, so a plain npm/dev install (execPath is the shared
 * node binary, never bin-sibling to a vendor tree) resolves nothing and stays a no-op.
 *
 * Mutates the REAL process.env by default (the runtime reads the real env); the env/arch/execPath
 * params exist for deterministic tests. Guarded: never overwrites an explicit SRT_WIN_PATH, never
 * sets a non-existent path.
 */
export function applyAsrtVendorEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
  execPath: string = process.execPath,
): void {
  if (platform !== 'win32') return; // the runtime honors no env hook for the posix seccomp helper
  if (env.SRT_WIN_PATH) return; // respect an explicit override
  const dir = env[VENDOR_DIR_ENV] ?? join(dirname(execPath), 'vendor');
  const a = vendorArch(arch);
  const candidates = [
    ...(a ? [join(dir, 'srt-win', a, 'srt-win.exe'), join(dir, a, 'srt-win.exe')] : []),
    join(dir, 'srt-win.exe'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) env.SRT_WIN_PATH = found;
}

/**
 * Resolve the staged apply-seccomp helper from MINITUI_ASRT_VENDOR_DIR (or its execPath-sibling
 * fallback) on Linux (`<dir>/seccomp/<arch>/apply-seccomp`, the runtime's vendor layout).
 *
 * This is the Linux half of the binary-channel helper consumer. Unlike win32's SRT_WIN_PATH env
 * hook, the runtime has no seccomp env override; the one seam is the seccomp.applyPath config field,
 * which buildSandboxConfig sets from this and initialize threads to the resolver — the resolver
 * checks the explicit path FIRST and re-validates existence, so when MINITUI_ASRT_VENDOR_DIR is
 * EXPLICITLY set we return the candidate path WITHOUT an existsSync here (keeping that path pure; a
 * missing file just falls back to the runtime's own walk exactly as the npm channel does).
 *
 * The execPath-sibling FALLBACK (the curl-piped channel, which has no launcher to set the env var)
 * is existence-gated instead: an inferred sibling dir cannot be assumed to exist, and an
 * always-truthy guess would break the "unset → undefined, npm channel unaffected" contract this
 * module has always had. Returns undefined off-Linux, for an unmapped arch, or when neither the
 * explicit env var nor the execPath-sibling layout resolves a real helper. The env/arch/execPath
 * params default to the real process values, overridable for tests.
 */
export function resolveSeccompApplyPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
  execPath: string = process.execPath,
): string | undefined {
  if (platform !== 'linux') return undefined;
  const a = vendorArch(arch);
  if (!a) return undefined;
  const explicitDir = env[VENDOR_DIR_ENV];
  if (explicitDir) return join(explicitDir, 'seccomp', a, 'apply-seccomp');
  const fallback = join(dirname(execPath), 'vendor', 'seccomp', a, 'apply-seccomp');
  return existsSync(fallback) ? fallback : undefined;
}
