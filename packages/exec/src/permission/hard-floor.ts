import { basename, posix } from 'node:path';
import type { ParsedCommand, CommandRoot } from '@minitui/types';
import { ARG_RUNNERS, normalizeCommandToken, STDIN_RUNNERS } from './shell/wrappers.js';
import { currentHost, foldsCase, homeRoots, type Host } from './shell/host.js';
import { textIsUnresolved } from './shell/operands.js';
import {
  HOME_SECRET_DIRS,
  HOME_SECRET_FILES,
  SECRET_BASENAME_PATTERNS,
  storeDir,
} from './secret-paths.js';

// Pure host helpers, shared with the extractor; exported here for the floor's own tests, not from the
// package barrel.
export { foldsCase, homeRoots };

// Egress binaries — never permitted, regardless of approval mode. A broad network-tool denylist;
// keeping it at curl/wget only would be bypassed by nc/ssh/httpie in one keystroke. This is
// belt-and-suspenders over the OS sandbox (the real egress control), NOT a complete boundary.
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

// One phrase for every net-redirect deny. It holds no part of the command: a command name reflected
// into a deny reason would put agent-authored text in front of the user.
const DEVNET_REASON = 'network access through a device path is never permitted';

// Patterns whose appearance in a normalized rm operand mean a WHOLE home/root recursive wipe. Both
// the bare ($HOME) and brace (${HOME}) expansion forms are matched — the parser keeps expansions as
// argv text, so a raw ${HOME} token must be caught here or `rm -rf ${HOME}` slips the floor. Matched
// EXACTLY: a home/root SUBPATH (`~/project`, `$HOME/build`) is a legitimate target and is NOT floored,
// consistent with the resolved-form policy below, which likewise floors only the exact home root.
const HOME_ROOT = [/^~$/, /^\$HOME$/, /^\$\{HOME\}$/, /^\/$/];

// What the floor needs per call: the host, whether its file system folds case, and the set of
// directories a recursive delete must never reach (folded when the host folds), and the program's own
// store directory, which no gated command may touch.
interface Floor {
  readonly host: Host;
  readonly fold: boolean;
  readonly homes: ReadonlySet<string>;
  readonly store: string;
}

const fold = (floor: Floor, text: string): string => (floor.fold ? text.toLowerCase() : text);

function floorFor(host: Host): Floor {
  const folds = foldsCase(host.platform);
  const homes = new Set(
    [...homeRoots(host.home, host.platform)].map((p) => (folds ? p.toLowerCase() : p)),
  );
  const store = storeDir(process.env, host.home);
  return { host, fold: folds, homes, store: folds ? store.toLowerCase() : store };
}

// HOME_ROOT above is textual-only, but roots.ts and the runner fill consent+exec holes with the
// host-RESOLVED absolute path, so `rm -rf /home/alice` (the resolved home root) matches NONE of the
// textual forms and would escape the floor under YOLO. Match the resolved home, its parent and the two
// literal parents EXACTLY — never subpaths: `rm -rf ~/project/build` is legitimate and must not floor.
// A trailing slash is normalized off before comparison.
function isFlooredPath(floor: Floor, token: string): boolean {
  const n = fold(floor, normalizeCommandToken(token).replace(/\/+$/, ''));
  return n !== '' && floor.homes.has(n);
}

// Secret locations — never touched (read OR written), regardless of approval mode.
// Deliberately excludes general system paths (e.g. /etc/passwd): a broad /etc/* pattern would
// false-positive on legitimate world-readable reads (/etc/hosts, /etc/resolv.conf). Arbitrary
// system-path writes are the OS sandbox's job (seatbelt/landlock writable-paths, invariant d).
// The list lives in secret-paths.ts. A listed home location matches as a run of path components
// wherever it appears; the anchor takes `=` as well as a path separator, so an attached path
// (`dd if=.env`) is caught.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const LISTED_LOCATIONS: readonly RegExp[] = [...HOME_SECRET_DIRS, ...HOME_SECRET_FILES].map(
  (name) => new RegExp(`(^|[/=])${escapeRegExp(name)}($|/)`),
);

// A path component, or the tail of one after an `=`, that is a secret file name.
function basenameHit(path: string): boolean {
  return path.split('/').some((component) =>
    component.split('=').some((_, i, parts) => {
      const tail = parts.slice(i).join('=');
      return SECRET_BASENAME_PATTERNS.some((re) => re.test(tail));
    }),
  );
}

// The concrete names behind SECRET_BASENAME_PATTERNS, for matching a glob component against.
const BASENAME_SECRETS = ['id_rsa', 'id_ed25519', '.env', 'credentials'];

// Every listed name as the components a glob can disguise (`.config/gh` is two).
const GLOB_TARGETS: ReadonlyArray<readonly string[]> = [
  ...HOME_SECRET_DIRS,
  ...HOME_SECRET_FILES,
  ...BASENAME_SECRETS,
].map((name) => name.split('/'));

const GLOB_CHAR = /[*?[]/;
const ANCHORED = /^(~|\$HOME|\$\{HOME\}|\/)/;

// The index of the `]` that closes the bracket expression opening at `start`, or -1. A `]` right after
// the opening (or after a leading `!` or `^`) is a member, and `[:name:]` is a character class.
function bracketEnd(pattern: string, start: number): number {
  let j = start + 1;
  if (pattern[j] === '!' || pattern[j] === '^') j++;
  if (pattern[j] === ']') j++;
  while (j < pattern.length) {
    if (pattern.startsWith('[:', j)) {
      const close = pattern.indexOf(':]', j + 2);
      if (close === -1) return -1;
      j = close + 2;
    } else if (pattern[j] === ']') return j;
    else j++;
  }
  return -1;
}

// One bracket expression as a regular expression. A negated set (`[!x]`, `[^x]`) and a set holding a
// character class (`[[:lower:]]`) match any single character of a component: over-approximating is the
// safe side for a pattern that is only ever used to deny.
function bracketSource(body: string): string {
  if (/^[!^]/.test(body) || body.includes('[')) return '[^/]';
  return `[${body.replace(/[\\\]]/g, '\\$&')}]`;
}

// A path component with glob characters as a regular expression over one component.
function globToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = bracketEnd(pattern, i);
      if (end === -1) source += '\\[';
      else {
        source += bracketSource(pattern.slice(i + 1, end));
        i = end;
      }
    } else source += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
}

const hasLiteralChar = (component: string): boolean =>
  component.replace(/\[[^\]]*\]|[*?]/g, '').length > 0;

// One window of path components against one listed name. Every glob component of the window must hold
// a literal character and match its part of the name; every other component must equal it. At least
// one glob component is required: a window without one is an ordinary path, left to the list match.
function globWindowHits(
  floor: Floor,
  components: readonly string[],
  start: number,
  target: readonly string[],
): boolean {
  let hasGlob = false;
  for (const [k, name] of target.entries()) {
    const component = components[start + k];
    if (component === undefined) return false;
    if (!GLOB_CHAR.test(component)) {
      if (fold(floor, component) !== fold(floor, name)) return false;
    } else if (hasLiteralChar(component) && globToRegExp(component, floor.fold).test(name)) {
      hasGlob = true;
    } else return false;
  }
  return hasGlob;
}

// An operand anchored at `~`, `$HOME` or `/` with a glob component that holds a literal character and
// matches a listed name (`~/.ss?/id_rs?`, `~/.ssh*/x`, `~/.net*`, `~/.confi?/gh`). A component made only
// of wildcards does not count: `ls ~/Videos/*` is left to the extractor, which makes the root opaque.
function globSecretHit(floor: Floor, token: string): boolean {
  if (!ANCHORED.test(token) || !GLOB_CHAR.test(token)) return false;
  const components = token.split('/');
  return GLOB_TARGETS.some((target) =>
    components.some((_, start) => globWindowHits(floor, components, start, target)),
  );
}

// The absolute form of an operand anchored at `~`, `$HOME`, `${HOME}` or `/`, with the home written in;
// undefined for any other operand.
function anchoredAbsolute(floor: Floor, operand: string): string | undefined {
  const home = /^(~|\$HOME|\$\{HOME\})(\/.*)?$/.exec(operand);
  const absolute = home ? `${floor.host.home}${home[2] ?? ''}` : operand;
  return absolute.startsWith('/') ? absolute : undefined;
}

// Whether a token names the program's store directory or anything under it, in an absolute, `~`-anchored
// or `$HOME`-anchored spelling, lexically (`..` resolved). A relative spelling is not caught: the
// sandbox write-deny is the control for a command that changes directory first.
function underStore(floor: Floor, token: string): boolean {
  return token.split('=').some((_, i, parts) => {
    const absolute = anchoredAbsolute(floor, parts.slice(i).join('='));
    if (absolute === undefined) return false;
    const resolved = fold(floor, posix.normalize(absolute));
    return resolved === floor.store || resolved.startsWith(`${floor.store}/`);
  });
}

function isSecretPath(floor: Floor, p: string): boolean {
  const n = normalizeCommandToken(p);
  // The names are listed in lower case, so a host that folds case compares the folded text. The anchored
  // forms (`$HOME`) keep their case.
  const folded = fold(floor, n);
  return (
    LISTED_LOCATIONS.some((re) => re.test(folded)) ||
    basenameHit(folded) ||
    globSecretHit(floor, n) ||
    underStore(floor, n)
  );
}

// Normalize an rm operand so glob/relative evasions of a WHOLE home/root wipe collapse to the bare
// target before matching: reduce to the longest leading glob-free prefix — everything before the
// first `*`, `?`, or `[` — so a nested wildcard (`/*/`, `/*/*`, `/home/*/`, `~/*/`) collapses onto the
// root it would expand across, not just a single trailing `/*`. Then posix-normalize (`//` -> `/`,
// drop a trailing slash). Subpaths of home stay subpaths (not floored); only the root floors.
function normalizeRmOperand(raw: string): string {
  const g = raw.search(/[*?[]/); // first glob metachar
  const prefix = g === -1 ? raw : raw.slice(0, g);
  if (prefix.length <= 1) return prefix; // '', '/', '~' pass through
  return posix.normalize(prefix).replace(/(?!^)\/+$/, ''); // // -> /, drop a trailing slash (keep root /)
}

// A glob operand matched as a PATTERN against the directories that must never be wiped, in addition
// to the prefix reduction above: `/ho*` and `/hom?` expand to `/home`, `/h*/*` and `/home/erki*` to
// the home directory. Only an absolute operand is matched, so `rm -rf *` in a working directory is the
// extractor's opaque ask, not a deny.
function globHitsFloored(floor: Floor, operand: string): boolean {
  if (!operand.startsWith('/') || !GLOB_CHAR.test(operand)) return false;
  const re = globToRegExp(operand.replace(/\/+$/, ''), floor.fold);
  return [...floor.homes].some((home) => re.test(home));
}

// An operand anchored at `~`, `$HOME`, `${HOME}` or `/` is resolved lexically, `.` and `..` included,
// and compared with the floored set: `~/..` is `/home`, `~/x/../..` too. A relative operand has no
// anchor, so the extractor makes its root opaque instead.
function dotDotHitsFloored(floor: Floor, operand: string): boolean {
  if (!operand.split('/').includes('..')) return false;
  const absolute = anchoredAbsolute(floor, operand);
  if (absolute === undefined) return false;
  const resolved = posix.normalize(absolute).replace(/(?!^)\/+$/, '');
  return resolved === '/' || isFlooredPath(floor, resolved);
}

// `~name` followed by anything but a slash (`~root`, `~+`, `~-`) with a `..` component: the home it
// names cannot be resolved, and `..` can climb out of it (`~root/../home`).
function userHomeDotDot(operand: string): boolean {
  return operand.startsWith('~') && operand[1] !== '/' && operand.split('/').includes('..');
}

// Every rm argument is judged, whether or not it begins with a dash (`rm -rf${IFS}~`).
function rmOperandHits(floor: Floor, token: string): boolean {
  const operand = normalizeCommandToken(token);
  if (textIsUnresolved(operand)) return true;
  const reduced = normalizeRmOperand(operand);
  // textual home/root form, a host-resolved floored directory, OR ~user (another user's whole home)
  if (HOME_ROOT.some((re) => re.test(reduced)) || isFlooredPath(floor, reduced)) return true;
  if (/^~[^/]+$/.test(reduced)) return true;
  return (
    globHitsFloored(floor, operand) || dotDotHitsFloored(floor, operand) || userHomeDotDot(operand)
  );
}

function rmHitsHomeOrRoot(floor: Floor, root: CommandRoot): boolean {
  if (fold(floor, root.name) !== 'rm') return false;
  return root.argv.slice(1).some((token) => rmOperandHits(floor, token));
}

// Any root whose argv references a secret path — covers reads (`cat ~/.ssh/id_rsa`), writes via a
// threaded redirect target (`echo x > ~/.ssh/authorized_keys`), and copies (`cp secret dst`).
function rootTouchesSecret(floor: Floor, root: CommandRoot): boolean {
  return root.argv.some((token) => isSecretPath(floor, token));
}

function rootHitsDevNet(root: CommandRoot): boolean {
  return root.argv.some((a) => DEVNET.test(normalizeCommandToken(a)));
}

// The egress binary a root would run, if any — its own name, OR (for a stdin-fed runner like xargs,
// whose target arrives via pipeline stdin but whose INNER command is on the command line) the first
// non-flag token after the runner. So `echo url | xargs curl` is floored as egress even though the
// URL is laundered through stdin. ponytail: first-non-flag heuristic — a `xargs -I {} curl` form with
// a separated placeholder can slip this belt; the OS sandbox network policy is the real control.
function egressBinaryOf(floor: Floor, root: CommandRoot): string | undefined {
  const name = fold(floor, root.name);
  if (EGRESS.has(name)) return name;
  if (STDIN_RUNNERS.has(name)) {
    const inner = root.argv.slice(1).find((t) => !t.startsWith('-'));
    const n = inner ? fold(floor, basename(normalizeCommandToken(inner))) : undefined;
    if (n !== undefined && EGRESS.has(n)) return n;
  }
  return undefined;
}

// Why one root is blocked, if it is. Order matters only for the wording: egress first, then the
// whole-home delete, then a secret path.
function reasonForRoot(floor: Floor, root: CommandRoot): string | undefined {
  const egress = egressBinaryOf(floor, root);
  if (egress !== undefined) return `network egress via ${egress} is never permitted`;
  if (rootHitsDevNet(root)) return DEVNET_REASON;
  if (rmHitsHomeOrRoot(floor, root)) return 'recursive delete of home or root is never permitted';
  if (rootTouchesSecret(floor, root)) return 'touching a secret file is never permitted';
  return undefined;
}

// A wrapper whose option the peel does not model arrives as an opaque root holding the argv it was
// written with. The inner command cannot be located, so every token after the wrapper name is judged
// as if it were the command name (`env -a x curl …`, `sudo --frob v rm -rf ~`).
function reasonForLaterTokens(floor: Floor, root: CommandRoot): string | undefined {
  if (root.opaque !== true || !ARG_RUNNERS.has(fold(floor, root.name))) return undefined;
  for (let i = 1; i < root.argv.length; i++) {
    const candidate: CommandRoot = {
      name: basename(normalizeCommandToken(root.argv[i] ?? '')),
      argv: root.argv.slice(i),
    };
    const reason = reasonForRoot(floor, candidate);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

// `host` defaults to the machine the process runs on, read at call time; a caller (or a test) that
// knows better passes its own.
export function checkHardFloor(
  parsed: ParsedCommand,
  paths?: readonly string[],
  host: Host = currentHost(),
): { blocked: boolean; reason?: string } {
  // a result the extractor could not fully account for is never something to approve
  if (parsed.parseError) {
    return { blocked: true, reason: 'a command that could not be parsed is never permitted' };
  }
  if (parsed.hasSubstitution) {
    return { blocked: true, reason: 'a command with shell substitution is never permitted' };
  }
  const floor = floorFor(host);
  if (paths?.some((p) => isSecretPath(floor, p))) {
    return { blocked: true, reason: 'accessing a protected secret location is never permitted' };
  }
  // a host-resolved path that IS the home root (or /home) is never a legitimate target — only the
  // catastrophic whole-home operand resolves here (subpaths are excluded by isFlooredPath).
  if (paths?.some((p) => isFlooredPath(floor, p))) {
    return { blocked: true, reason: 'operating on the home root directory is never permitted' };
  }
  for (const root of parsed.roots) {
    const reason = reasonForRoot(floor, root) ?? reasonForLaterTokens(floor, root);
    if (reason !== undefined) return { blocked: true, reason };
  }
  return { blocked: false };
}
