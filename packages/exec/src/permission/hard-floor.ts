import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { ParsedCommand, CommandRoot } from '@minitui/types';
import { normalizeCommandToken, STDIN_RUNNERS } from './shell/wrappers.js';

// Egress binaries — never permitted, regardless of approval mode. A broad network-tool denylist;
// keeping it at curl/wget only would be bypassed by nc/ssh/httpie in one keystroke. This is
// belt-and-suspenders over the OS sandbox (invariant (d), the real egress control), NOT a complete boundary.
const EGRESS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'scp',
  'ssh',
  'sftp',
  'telnet',
  'aria2c',
  'axel',
  'curlie',
  'httpie',
  'http',
  'xh',
  'w3m',
  'lynx',
  'links',
]);

// bash net-redirect egress: `cat f > /dev/tcp/host/port` (the redirect target is threaded onto
// the root argv by roots.ts). Also /dev/udp.
const DEVNET = /\/dev\/(tcp|udp)\//;

// Patterns whose appearance in a normalized rm operand mean a WHOLE home/root recursive wipe. Both
// the bare ($HOME) and brace (${HOME}) expansion forms are matched — the parser keeps expansions as
// argv text, so a raw ${HOME} token must be caught here or `rm -rf ${HOME}` slips the floor. Matched
// EXACTLY: a home/root SUBPATH (`~/project`, `$HOME/build`) is a legitimate target and is NOT floored,
// consistent with the resolved-form policy below, which likewise floors only the exact home root.
const HOME_ROOT = [/^~$/, /^\$HOME$/, /^\$\{HOME\}$/, /^\/$/];

// HOME_ROOT above is textual-only, but roots.ts and the runner fill consent+exec holes with the
// host-RESOLVED absolute path, so `rm -rf /home/alice` (the resolved home root) matches NONE of the
// textual forms and would escape the floor under YOLO. Match the resolved `os.homedir()` value and
// the parent `/home` EXACTLY — never subpaths: `rm -rf ~/project/build` is legitimate and must not
// floor. A trailing slash is normalized off before comparison. A degenerate homedir() of `/` reduces
// to '' and is excluded by the non-empty guard (bare `/` is already caught by HOME_ROOT above).
const RESOLVED_HOME_ROOTS: ReadonlySet<string> = new Set(
  [homedir(), '/home'].map((p) => p.replace(/\/+$/, '')).filter((p) => p !== ''),
);

function isResolvedHomeRoot(token: string): boolean {
  const n = normalizeCommandToken(token).replace(/\/+$/, '');
  return n !== '' && RESOLVED_HOME_ROOTS.has(n);
}

// Secret locations — never touched (read OR written), regardless of approval mode.
// Deliberately excludes general system paths (e.g. /etc/passwd): a broad /etc/* pattern would
// false-positive on legitimate world-readable reads (/etc/hosts, /etc/resolv.conf). Arbitrary
// system-path writes are the OS sandbox's job (seatbelt/landlock writable-paths, invariant d).
const SECRET_PATTERNS = [
  /(^|\/)\.ssh($|\/)/,
  /(^|\/)\.aws($|\/)/,
  /(^|\/)\.gnupg($|\/)/,
  /(^|\/)id_rsa($|$)/,
  /(^|\/)id_ed25519($|$)/,
  /(^|\/)\.env(\.[^/]*)?($|\/)/, // .env AND .env.local / .env.production
  /(^|\/)\.netrc($|$)/,
  /(^|\/)\.npmrc($|$)/,
  /(^|\/)credentials($|$)/,
  /\.pem($|\/)/, // any *.pem key/cert anywhere on the path
];

function isSecretPath(p: string): boolean {
  const n = normalizeCommandToken(p);
  return SECRET_PATTERNS.some((re) => re.test(n));
}

// Normalize an rm operand so glob/relative evasions of a WHOLE home/root wipe collapse to the bare
// target before matching: a trailing `/*` or `/.` is stripped (`rm -rf /*` wipes `/`), then the path
// is posix-normalized (`//` -> `/`, drop a trailing slash). Subpaths of home stay subpaths (not
// floored); only the root collapses to a floored form.
function normalizeRmOperand(token: string): string {
  const stripped = normalizeCommandToken(token).replace(/\/(\*|\.)$/, '/'); // /* or /. suffix -> parent
  if (stripped.length <= 1) return stripped;
  return posix.normalize(stripped).replace(/(?!^)\/+$/, ''); // // -> /, drop a trailing slash (keep root /)
}

function rmHitsHomeOrRoot(root: CommandRoot): boolean {
  if (root.name !== 'rm') return false;
  return root.argv.some((a) => {
    const n = normalizeRmOperand(a);
    // textual home/root form, the host-resolved home root, OR ~user (another user's whole home)
    return HOME_ROOT.some((re) => re.test(n)) || isResolvedHomeRoot(n) || /^~[^/]+$/.test(n);
  });
}

// Any root whose argv references a secret path — covers reads (`cat ~/.ssh/id_rsa`), writes via a
// threaded redirect target (`echo x > ~/.ssh/authorized_keys`), and copies (`cp secret dst`).
function rootTouchesSecret(root: CommandRoot): boolean {
  return root.argv.some(isSecretPath);
}

function rootHitsDevNet(root: CommandRoot): boolean {
  return root.argv.some((a) => DEVNET.test(normalizeCommandToken(a)));
}

// The egress binary a root would run, if any — its own name, OR (for a stdin-fed runner like xargs,
// whose target arrives via pipeline stdin but whose INNER command is on the command line) the first
// non-flag token after the runner. So `echo url | xargs curl` is floored as egress even though the
// URL is laundered through stdin. ponytail: first-non-flag heuristic — a `xargs -I {} curl` form with
// a separated placeholder can slip this belt; the OS sandbox network policy is the real control.
function egressBinaryOf(root: CommandRoot): string | undefined {
  if (EGRESS.has(root.name)) return root.name;
  if (STDIN_RUNNERS.has(root.name)) {
    const inner = root.argv.slice(1).find((t) => !t.startsWith('-'));
    const n = inner ? normalizeCommandToken(inner) : undefined;
    if (n !== undefined && EGRESS.has(n)) return n;
  }
  return undefined;
}

export function checkHardFloor(
  parsed: ParsedCommand,
  paths?: readonly string[],
): { blocked: boolean; reason?: string } {
  if (paths?.some(isSecretPath)) {
    return { blocked: true, reason: 'accessing a protected secret location is never permitted' };
  }
  // a host-resolved path that IS the home root (or /home) is never a legitimate target — only the
  // catastrophic whole-home operand resolves here (subpaths are excluded by isResolvedHomeRoot).
  if (paths?.some(isResolvedHomeRoot)) {
    return { blocked: true, reason: 'operating on the home root directory is never permitted' };
  }
  for (const root of parsed.roots) {
    const egress = egressBinaryOf(root);
    if (egress !== undefined || rootHitsDevNet(root)) {
      return {
        blocked: true,
        reason: `network egress via ${egress ?? root.name} is never permitted`,
      };
    }
    if (rmHitsHomeOrRoot(root)) {
      return { blocked: true, reason: 'recursive delete of home or root is never permitted' };
    }
    if (rootTouchesSecret(root)) {
      return { blocked: true, reason: 'touching a secret file is never permitted' };
    }
  }
  return { blocked: false };
}
