import { basename, posix } from 'node:path';
import type { ParsedCommand, CommandRoot } from '@minitui/types';
import { ARG_RUNNERS, normalizeCommandToken, STDIN_RUNNERS } from './shell/wrappers.js';
import { currentHost, foldCase, foldsCase, homeRoots, type Host } from './shell/host.js';
import { textIsUnresolved } from './shell/operands.js';
import {
  ENV_FILE_NAME,
  HOME_SECRET_DIRS,
  HOME_SECRET_FILES,
  SECRET_FILE_NAMES,
  isSecretFileName,
} from './secret-paths.js';

// Pure host helpers, shared with the extractor; exported here for the floor's own tests, not from the
// package barrel. The glob matcher and tokenizer are exported for the same reason: the tests run the
// landed code against a reference matcher.
export { foldsCase, homeRoots, globMatcher, tokenizeGlob };

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
  'netcat',
  'nc.openbsd',
  'nc.traditional',
  'socat',
  'openssl',
  'ftp',
  'rsh',
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
  // the directories that hold home directories: `homes` without this host's own home
  readonly parents: ReadonlySet<string>;
  readonly store: string;
}

const fold = (floor: Floor, text: string): string => (floor.fold ? foldCase(text) : text);

function floorFor(host: Host): Floor {
  const folds = foldsCase(host.platform);
  const homes = new Set(
    [...homeRoots(host.home, host.platform)].map((p) => (folds ? foldCase(p) : p)),
  );
  const ownHome = host.home.replace(/\/+$/, '');
  const parents = new Set([...homes].filter((p) => p !== (folds ? foldCase(ownHome) : ownHome)));
  return { host, fold: folds, homes, parents, store: folds ? foldCase(host.store) : host.store };
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

// Another account's home directory: a resolved path exactly one level below a directory that holds
// home directories (the parent of this host's home, /home, /Users). Deleting it is as catastrophic as
// deleting the user's own. `/home/x/build` is a subpath of it and is not floored, and a child of the
// root (`/x`) is never swept in, because `/` is not one of those parents. A shared directory such as
// /home/shared or /Users/Shared is floored too (recorded cost: no gated command may delete it). When
// the user's own home is itself /home or /Users, that directory is not a parent here: its children are
// subpaths of the user's home, which stay allowed. The comparison is lexical, as for the user's own
// home: an alias of a parent (a firmlink such as /System/Volumes/Data/Users, a /home that is a link)
// is not resolved, and the sandbox write-deny is the control for those spellings.
function isSiblingHome(floor: Floor, absolute: string): boolean {
  const n = fold(floor, absolute.replace(/\/+$/, ''));
  const slash = n.lastIndexOf('/');
  return slash > 0 && slash < n.length - 1 && floor.parents.has(n.slice(0, slash));
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
const basenameHit = (path: string): boolean => path.split('/').some(isSecretFileName);

// The concrete secret file names, for matching a glob component against. An ending (`*.pem`) has no
// concrete name; a glob that could spell one is left to the extractor's opaque ask.
const BASENAME_SECRETS = [...SECRET_FILE_NAMES, ENV_FILE_NAME];

// Every listed name as the components a glob can disguise (`.config/gh` is two).
const GLOB_TARGETS: ReadonlyArray<readonly string[]> = [
  ...HOME_SECRET_DIRS,
  ...HOME_SECRET_FILES,
  ...BASENAME_SECRETS,
].map((name) => name.split('/'));

const GLOB_CHAR = /[*?[]/;
const ANCHORED = /^(~|\$HOME|\$\{HOME\}|\/)/;

// A glob as tokens. The floor only ever uses a glob to DENY, so every construct it does not model exactly
// is widened, never narrowed: a negated set (`[!x]`, `[^x]`) and a set the regular expression engine
// rejects (`[z-a]`) match any one character, and an irregular bracket (a `[` or a backslash inside it,
// which covers `[:class:]`, `[=c=]`, `[.c.]` and an unclosed class) matches any run of characters up to
// the last `]` of its path component. A path is expanded one component at a time and no bracket reaches
// across a `/`, so the scan of a bracket stops at the end of its component.
type GlobToken =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'many' }
  | { readonly kind: 'one' }
  // `selective`: a short explicit list of characters, which can spell part of a name (`[.]`, `[sS]`)
  | { readonly kind: 'set'; readonly source: string; readonly selective: boolean };

// The index of the `]` that closes a plain bracket expression opening at `start` inside a component that
// ends at `limit`, or -1 when the bracket is irregular or never closes. A `]` right after the opening (or
// after a leading `!` or `^`) is a member.
function plainSetEnd(pattern: string, start: number, limit: number): number {
  let j = start + 1;
  if (pattern[j] === '!' || pattern[j] === '^') j++;
  if (pattern[j] === ']') j++;
  for (; j < limit; j++) {
    const ch = pattern[j];
    if (ch === ']') return j;
    if (ch === '[' || ch === '\\') return -1;
  }
  return -1;
}

function setToken(body: string): GlobToken {
  if (/^[!^]/.test(body)) return { kind: 'one' };
  const source = `[${body.replace(/[\\\]]/g, '\\$&')}]`;
  try {
    new RegExp(source);
    return { kind: 'set', source, selective: body.length <= 4 && !body.includes('-') };
  } catch {
    return { kind: 'one' };
  }
}

// The end (the next slash, or the end of the pattern) of the path component that holds `start`, and the
// last `]` between `start` and that end (-1 when there is none). One forward scan, so the tokenizer stays
// linear in the pattern however many brackets it holds.
function componentAhead(pattern: string, start: number): { end: number; lastClose: number } {
  let lastClose = -1;
  let j = start;
  for (; j < pattern.length && pattern[j] !== '/'; j++) if (pattern[j] === ']') lastClose = j;
  return { end: j, lastClose };
}

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let ahead = { end: -1, lastClose: -1 };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') tokens.push({ kind: 'many' });
    else if (c === '?') tokens.push({ kind: 'one' });
    else if (c === '[') {
      if (i >= ahead.end) ahead = componentAhead(pattern, i);
      const end = plainSetEnd(pattern, i, ahead.end);
      if (end !== -1) {
        tokens.push(setToken(pattern.slice(i + 1, end)));
        i = end;
      } else if (ahead.lastClose > i) {
        tokens.push({ kind: 'many' });
        i = ahead.lastClose;
      } else tokens.push({ kind: 'literal', text: c });
    } else tokens.push({ kind: 'literal', text: c });
  }
  return tokens;
}

// A glob as steps over a subject: a run of characters that holds no slash, or a test of one character.
type GlobStep =
  | { readonly kind: 'many' }
  | { readonly kind: 'char'; readonly accepts: (ch: string) => boolean };

const notSlash = (ch: string): boolean => ch !== '/';

function stepOf(token: GlobToken, ignoreCase: boolean): GlobStep {
  if (token.kind === 'many') return { kind: 'many' };
  if (token.kind === 'one') return { kind: 'char', accepts: notSlash };
  if (token.kind === 'literal' && !ignoreCase) {
    const text = token.text;
    return { kind: 'char', accepts: (ch) => ch === text };
  }
  const source =
    token.kind === 'set' ? token.source : token.text.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  const one = new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
  return { kind: 'char', accepts: (ch) => one.test(ch) };
}

// A glob as a matcher over a whole subject. It never backtracks: `reach[i]` says whether the steps read
// so far can consume the first `i` characters of the subject, so the work is the number of steps times
// the length of the subject whatever the pattern holds. A regular expression with one `[^/]*` per star
// backtracks exponentially in a run of stars that ends in a character the subject lacks.
function globMatcher(pattern: string, ignoreCase: boolean): (subject: string) => boolean {
  const steps = tokenizeGlob(pattern).map((token) => stepOf(token, ignoreCase));
  return (subject) => {
    const length = subject.length;
    let reach = new Uint8Array(length + 1);
    reach[0] = 1;
    for (const step of steps) {
      const next = new Uint8Array(length + 1);
      let any = false;
      for (let i = 0; i <= length; i++) {
        const ch = subject[i - 1] ?? '';
        const reached =
          step.kind === 'many'
            ? reach[i] === 1 || (i > 0 && next[i - 1] === 1 && ch !== '/')
            : i > 0 && reach[i - 1] === 1 && step.accepts(ch);
        if (reached) {
          next[i] = 1;
          any = true;
        }
      }
      if (!any) return false;
      reach = next;
    }
    return reach[length] === 1;
  };
}

// Whether a component can spell part of a name: a literal character or a short explicit set. A
// component made only of wildcards, ranges and negations (`*`, `[a-z]*`, `[!.]*`) is not selective: it
// would match the listed names by chance, and it is left to the extractor's opaque ask.
const isSelective = (component: string): boolean =>
  tokenizeGlob(component).some(
    (token) => token.kind === 'literal' || (token.kind === 'set' && token.selective),
  );

// One glob component, read once per operand: whether it can spell part of a name, and its matcher.
interface GlobComponent {
  readonly selective: boolean;
  readonly matches: (subject: string) => boolean;
}

// One window of path components against one listed name. Every glob component of the window must be
// selective and match its part of the name; every other component must equal it. At least
// one glob component is required: a window without one is an ordinary path, left to the list match.
function globWindowHits(
  floor: Floor,
  components: readonly string[],
  start: number,
  target: readonly string[],
  globAt: (index: number) => GlobComponent,
): boolean {
  let hasGlob = false;
  for (const [k, name] of target.entries()) {
    const component = components[start + k];
    if (component === undefined) return false;
    if (!GLOB_CHAR.test(component)) {
      if (fold(floor, component) !== fold(floor, name)) return false;
    } else {
      const glob = globAt(start + k);
      if (!glob.selective || !glob.matches(name)) return false;
      hasGlob = true;
    }
  }
  return hasGlob;
}

// An operand anchored at `~`, `$HOME` or `/` with a glob component that holds a literal character and
// matches a listed name (`~/.ss?/id_rs?`, `~/.ssh*/x`, `~/.net*`, `~/.confi?/gh`). A component made only
// of wildcards does not count: `ls ~/Videos/*` is left to the extractor, which makes the root opaque.
function globSecretHit(floor: Floor, token: string): boolean {
  if (!ANCHORED.test(token) || !GLOB_CHAR.test(token)) return false;
  const components = token.split('/');
  const read = new Map<number, GlobComponent>();
  const globAt = (index: number): GlobComponent => {
    const known = read.get(index);
    if (known !== undefined) return known;
    const text = components[index] ?? '';
    const glob = {
      selective: isSelective(text),
      matches: globMatcher(fold(floor, text), floor.fold),
    };
    read.set(index, glob);
    return glob;
  };
  return GLOB_TARGETS.some((target) =>
    components.some((_, start) => globWindowHits(floor, components, start, target, globAt)),
  );
}

// The absolute form of an operand anchored at `~`, `$HOME`, `${HOME}` or `/`, with the home written in;
// undefined for any other operand.
function anchoredAbsolute(floor: Floor, operand: string): string | undefined {
  const home = /^(~|\$HOME|\$\{HOME\})(\/.*)?$/.exec(operand);
  const absolute = home ? `${floor.host.home}${home[2] ?? ''}` : operand;
  return absolute.startsWith('/') ? absolute : undefined;
}

// Each anchored tail of a token costs a pass over the rest of it, so a token with more than this many
// anchored tails (a `=` followed by `~`, `$HOME` or `/`) is treated as naming the store: the work stays
// bounded and the answer errs toward the deny. No command a person writes holds that many.
const MAX_ANCHORED_TAILS = 64;

// Whether a token names the program's store directory or anything under it, in an absolute, `~`-anchored
// or `$HOME`-anchored spelling, lexically (`..` resolved). A relative spelling is not caught: the
// sandbox write-deny is the control for a command that changes directory first.
function underStore(floor: Floor, token: string): boolean {
  let anchored = 0;
  for (let start = 0; ; ) {
    const absolute = anchoredAbsolute(floor, token.slice(start));
    if (absolute !== undefined) {
      anchored += 1;
      if (anchored > MAX_ANCHORED_TAILS) return true;
      const resolved = fold(floor, posix.normalize(absolute));
      if (resolved === floor.store || resolved.startsWith(`${floor.store}/`)) return true;
    }
    const eq = token.indexOf('=', start);
    if (eq === -1) return false;
    start = eq + 1;
  }
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

// A glob component that leads with a literal dot (or a bracket holding one) and can spell `..`: `.?`,
// `.*`, `.[.]`. A shell that matches the dot entries expands it to the parent directory, which the
// lexical collapse of a resolved operand cannot see (`/tmp/.?/home/x` is `/home/x`).
function globMayBeDotDot(floor: Floor, component: string): boolean {
  if (!GLOB_CHAR.test(component)) return false;
  const leadsWithDot =
    component.startsWith('.') || (component.startsWith('[') && component.includes('.'));
  if (!leadsWithDot) return false;
  return globMatcher(component, floor.fold)('..');
}

// A glob operand matched as a PATTERN against the directories that must never be wiped, in addition
// to the prefix reduction above: `/ho*` and `/hom?` expand to `/home`, `/h*/*` and `/home/erki*` to
// the home directory. Only an absolute operand is matched, so `rm -rf *` in a working directory is the
// extractor's opaque ask, not a deny.
function globHitsFloored(floor: Floor, operand: string): boolean {
  if (!operand.startsWith('/') || !GLOB_CHAR.test(operand)) return false;
  const pattern = operand.replace(/\/+$/, '');
  const matches = globMatcher(pattern, floor.fold);
  return [...floor.homes].some((home) => matches(home)) || globBeneathParent(floor, pattern);
}

// The same pattern read one level up: when everything before its last component can be one of the
// directories that hold home directories, the pattern expands to a child of it, which is another
// account's home (`/ho*/x`, `/h?me/x*`). A glob any deeper only reaches subpaths of a home.
function globBeneathParent(floor: Floor, pattern: string): boolean {
  const slash = pattern.lastIndexOf('/');
  if (slash <= 0 || slash === pattern.length - 1) return false;
  const head = globMatcher(pattern.slice(0, slash), floor.fold);
  return [...floor.parents].some((parent) => head(parent));
}

// The lexically resolved absolute form of an operand anchored at `~`, `$HOME`, `${HOME}` or `/`: the
// home written in, `.` and `..` collapsed (a glob character is ordinary text to the collapse), a trailing
// slash dropped; undefined for any other operand. The glob checks read this form, so a `..` ahead of a
// glob (`/tmp/../ho*/x`, `~/../../ho*`) cannot hide what the glob expands to.
function resolvedOperand(floor: Floor, operand: string): string | undefined {
  const absolute = anchoredAbsolute(floor, operand);
  return absolute === undefined ? undefined : posix.normalize(absolute).replace(/(?!^)\/+$/, '');
}

// An operand anchored at `~`, `$HOME`, `${HOME}` or `/` is resolved lexically, `.` and `..` included,
// and compared with the floored set: `~/..` is `/home`, `~/x/../..` too. A relative operand has no
// anchor, so the extractor makes its root opaque instead.
function dotDotHitsFloored(floor: Floor, operand: string): boolean {
  if (!operand.split('/').includes('..')) return false;
  const resolved = resolvedOperand(floor, operand);
  if (resolved === undefined) return false;
  return resolved === '/' || isFlooredPath(floor, resolved) || isSiblingHome(floor, resolved);
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
  // an anchored operand with a component that can spell `..` cannot be resolved lexically: refused
  if (ANCHORED.test(operand) && operand.split('/').some((c) => globMayBeDotDot(floor, c))) {
    return true;
  }
  const reduced = normalizeRmOperand(operand);
  // textual home/root form, a host-resolved floored directory, OR ~user (another user's whole home)
  if (HOME_ROOT.some((re) => re.test(reduced)) || isFlooredPath(floor, reduced)) return true;
  if (/^~[^/]+$/.test(reduced) || (reduced.startsWith('/') && isSiblingHome(floor, reduced))) {
    return true;
  }
  return (
    globHitsFloored(floor, resolvedOperand(floor, operand) ?? operand) ||
    dotDotHitsFloored(floor, operand) ||
    userHomeDotDot(operand)
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
  return egressNameAt(floor, root.argv, 0, fold(floor, root.name));
}

// The same for the command named (already folded) by the token at index `at` of an argv. The search for
// a stdin-fed runner's inner command stops at the first token after it that is not an option.
function egressNameAt(
  floor: Floor,
  argv: readonly string[],
  at: number,
  name: string,
): string | undefined {
  if (EGRESS.has(name)) return name;
  if (!STDIN_RUNNERS.has(name)) return undefined;
  for (let j = at + 1; j < argv.length; j++) {
    const token = argv[j] ?? '';
    if (token.startsWith('-')) continue;
    const inner = fold(floor, basename(normalizeCommandToken(token)));
    return EGRESS.has(inner) ? inner : undefined;
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
  const argv = root.argv;
  // Each token is judged once; "some token from index i on" is read from a flag per index, so the work is
  // linear in the argv where a candidate root per index would be quadratic. The order of the checks per
  // candidate is the order of reasonForRoot.
  const devNetFrom = fromHere(argv, (token) => DEVNET.test(normalizeCommandToken(token)));
  const deleteFrom = fromHere(argv, (token) => rmOperandHits(floor, token));
  const secretFrom = fromHere(argv, (token) => isSecretPath(floor, token));
  for (let i = 1; i < argv.length; i++) {
    const name = fold(floor, basename(normalizeCommandToken(argv[i] ?? '')));
    const egress = egressNameAt(floor, argv, i, name);
    if (egress !== undefined) return `network egress via ${egress} is never permitted`;
    if (devNetFrom[i] === true) return DEVNET_REASON;
    if (name === 'rm' && deleteFrom[i + 1] === true) {
      return 'recursive delete of home or root is never permitted';
    }
    if (secretFrom[i] === true) return 'touching a secret file is never permitted';
  }
  return undefined;
}

// flags[i] is true when the test holds for some token at index i or later.
function fromHere(argv: readonly string[], test: (token: string) => boolean): boolean[] {
  const flags = Array.from({ length: argv.length + 1 }, () => false);
  for (let i = argv.length - 1; i >= 0; i--) {
    flags[i] = flags[i + 1] === true || test(argv[i] ?? '');
  }
  return flags;
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
