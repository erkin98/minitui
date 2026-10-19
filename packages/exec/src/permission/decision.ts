import type { ParsedCommand, CommandRoot, PermissionRule } from '@minitui/types';
import { effectFor, exactRuleFor, matchedRule, type RuleSet } from './rules.js';
import { STDIN_RUNNERS, isQualifiedPath } from './shell/wrappers.js';
import { defaultResolveExecutable, type ResolveExecutable } from './resolve-exec.js';

// Per-tool arg semantics — a hardening for the two highest-value safelisted tools (git + ffmpeg),
// NOT a blanket safelist of find/rg/base64/sed (those stay ask). Each returns true when the
// invocation subverts what the tool's allow rule was granted for, so resolveStatic downgrades that
// allow to ask.

// git global-option hijack. `-c core.pager=<cmd>` / `-c alias.x=!<cmd>` run arbitrary code;
// `-C <dir>`/`--git-dir`/`--work-tree` retarget the repo; `--exec-path`/`--config-env`/
// `--super-prefix` redirect binaries/config.
const UNSAFE_GIT_LONG_OPTS = [
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
];

function gitGlobalOptionUnsafe(root: CommandRoot): boolean {
  if (root.name !== 'git') return false;
  for (const tok of root.argv.slice(1)) {
    if (!tok.startsWith('-')) return false; // first non-flag token is the subcommand — stop scan
    // -C / -C<dir>, -c / -c<name=val> (short-with-inline-value), -p / --paginate pager
    if (tok.startsWith('-C') || tok.startsWith('-c') || tok === '-p' || tok === '--paginate')
      return true;
    if (UNSAFE_GIT_LONG_OPTS.some((o) => tok === o || tok.startsWith(`${o}=`))) return true;
  }
  return false;
}

// Options after the git subcommand that run a program, with the option written as given: a long option
// matches itself, itself followed by '=', or an abbreviation of it (git takes any unambiguous prefix of a
// long option, so '--upload-p=x' is '--upload-pack=x'; a prefix of three characters or more counts, and
// an ambiguous one is an error in git anyway); a short option matches wherever its letter sits in a
// single-dash token, since git bundles short options ('-cname=val', '-xcmd', '-iOless', '-qc'). That asks
// about a few harmless tokens ('-bfeature' holds a 'u'), which is the safe direction. The first key
// applies to every subcommand. The scan of the global options
// before the subcommand is the one above. Recorded limit: other ways git runs a program (aliases and hooks
// in a repository's own config, filter-branch, mergetool, a pager set in config) are not modelled; the
// sandbox is the control.
const UNSAFE_GIT_SUBCOMMAND_OPTS: Readonly<Record<string, readonly string[]>> = {
  '*': ['--upload-pack', '--receive-pack', '--exec', '--extcmd'],
  // --template takes hooks from another directory, which git then runs
  clone: ['-c', '--config', '-u', '--template'],
  init: ['--template'],
  grep: ['-O', '--open-files-in-pager'],
  rebase: ['-x'],
  difftool: ['-x'],
};

function gitOptionHit(token: string, option: string): boolean {
  if (option.length === 2) return /^-[^-]/.test(token) && token.slice(1).includes(option[1] ?? '');
  if (!token.startsWith('--')) return false;
  const name = token.split('=', 1)[0] ?? token;
  return name.length >= 3 && option.startsWith(name);
}

function gitSubcommandUnsafe(root: CommandRoot): boolean {
  if (root.name !== 'git') return false;
  const args = root.argv.slice(1);
  const at = args.findIndex((a) => !a.startsWith('-'));
  const sub = args[at];
  if (at === -1 || sub === undefined) return false;
  const rest = args.slice(at + 1);
  const options = [
    ...(UNSAFE_GIT_SUBCOMMAND_OPTS['*'] ?? []),
    ...(UNSAFE_GIT_SUBCOMMAND_OPTS[sub] ?? []),
  ];
  if (rest.some((token) => options.some((option) => gitOptionHit(token, option)))) return true;
  // `bisect run <cmd>` and `submodule ... foreach <cmd>` run the command that follows
  return (
    (sub === 'bisect' && rest[0] === 'run') || (sub === 'submodule' && rest.includes('foreach'))
  );
}

// ffmpeg/ffprobe input that fetches or wraps another input — the canonical ffmpeg SSRF/exfil vector. A
// local-transcode grant must NOT auto-cover an argument that turns ffmpeg into a network client
// (`-i http://…`, any `xxx://`) or that names a protocol which reads further inputs from a list or
// pipes them through (`concat:a|b`, `concatf:list`, `cache:`, …: a list file of URLs makes a local-looking
// token a network input). curl/wget stay in the non-overridable hard-floor because they are PURELY network
// tools; ffmpeg is a legitimate local tool that CAN fetch, so such an argument downgrades to ask (the
// human confirms the fetch) rather than a hard deny. Option tokens (`-c:v`, `-map 0:a`) are not judged,
// and a time like `00:01:00` is not a protocol. `data:`, `fd:`, `file:`, `pipe:` and `bluray:` are local only.
const FFMPEG_WRAPPER_PREFIXES = [
  'async:',
  'cache:',
  'concat:',
  'concatf:',
  'crypto:',
  'subfile,',
  'tee:',
  'unix:',
];

// A wrapper prefix starts the argument or follows a filtergraph separator (`movie=cache:x`, `a,tee:x`).
// A filename in a filtergraph always follows an `=`, whether positional or named.
const FFMPEG_WRAPPER = new RegExp(
  `(^|[=,;\\s])(${FFMPEG_WRAPPER_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'i',
);

// A filtergraph unescapes a backslash before any character and takes single quotes as quoting, so
// `http\:\/\/host` is `http://host` there and `ca'che':x` is `cache:x`; the argument is judged after both are
// removed. Recorded limit: the input formats that read further inputs
// from a list (`-f concat`, `-f hls`, `-f lavfi`) are not flagged: `-f concat` is the ordinary merge
// input, ffmpeg's own protocol whitelist covers a local list file, and the sandbox is the control.
function ffmpegNetworkInput(root: CommandRoot): boolean {
  if (root.name !== 'ffmpeg' && root.name !== 'ffprobe') return false;
  return root.argv.slice(1).some((arg) => {
    if (arg.startsWith('-')) return false;
    const text = arg.replace(/\\(.)/gs, '$1').replace(/'/g, '').toLowerCase();
    return text.includes('://') || FFMPEG_WRAPPER.test(text);
  });
}

// Exported so the ENGINE can treat an unsafe-tool-arg invocation as NON-YOLO-upgradable:
// resolveStatic downgrades allow->ask here, and the engine additionally refuses to let YOLO lift
// that ask — an `ask` YOLO override would defeat the downgrade (git global-opt / ffmpeg SSRF).
export function unsafeToolArgs(root: CommandRoot): boolean {
  return gitGlobalOptionUnsafe(root) || gitSubcommandUnsafe(root) || ffmpegNetworkInput(root);
}

// grant-identity binding. True when an `allow` for this root is won by an identity-bearing grant
// (`.identity` = the realpath captured at mint) whose bound realpath no longer equals what `argv[0]`
// resolves to NOW — a mid-session $PATH/symlink swap of a same-basename binary. Mirrors resolveStatic's
// byArgv-then-byName-then-exact precedence via the SAME primitives, so the rule it reads can never
// disagree with the effect resolveStatic saw. `raw` is the command string the exact rule is compared with. Name-only grants (operator config, legacy) return false
// — today's match is unchanged. Exported so the engine can add it to the NON-YOLO-liftable `uncertain`
// set (a resolved identity the host cannot vouch for is host-uncertainty, must reach the human even
// under YOLO).
export function identityMismatch(
  root: CommandRoot,
  rules: RuleSet,
  resolveExecutable: ResolveExecutable,
  raw: string,
): boolean {
  const matched =
    matchedRule(rules, root.argv.join(' ')) ??
    matchedRule(rules, root.name) ??
    exactRuleFor(rules, raw);
  if (matched?.effect !== 'allow' || matched.identity === undefined) return false;
  return resolveExecutable(root.argv[0] ?? root.name) !== matched.identity;
}

// The command with its first word replaced by the root name: a path-written executable is judged
// by name as well, so a deny written for the name fires on `/usr/bin/git push` too.
const namedInvocation = (root: CommandRoot): string => [root.name, ...root.argv.slice(1)].join(' ');

// Deny-first triad over a parsed command. Order is FIXED and specificity never reorders it:
//   any deny       -> deny
//   else any reason to ask (parse error, substitution, opaque spawner, missing allow) -> ask
//   else (all roots explicitly allowed, nothing forces ask) -> allow
//
// An opaque root (roots.ts sets opaque:true on a spawner like `sh -c` or on a wrapper peeled to an
// empty inner command like `env -S 'curl …'`) forces ask even when a rule allows that name — the
// quoted payload is unparseable, never strip-and-trust. This branch is LOAD-BEARING and NOT redundant
// with the engine's YOLO check: an operator `allow npx`/`allow env`/`allow sh` rule makes the opaque
// root's effect `allow`, and the engine short-circuits on an `allow` verdict BEFORE its YOLO
// `uncertain` block runs, so the opaque close must ALSO live here.
// The deny-first triad plus the three allow->ask hardenings (trusted-basename, per-tool arg
// semantics, grant-identity) are one linear security decision; splitting them would scatter the
// load-bearing deny-first order and make it harder to audit.
// eslint-disable-next-line complexity
export function resolveStatic(
  parsed: ParsedCommand,
  rules: RuleSet,
  resolveExecutable: ResolveExecutable = defaultResolveExecutable,
): 'deny' | 'ask' | 'allow' {
  // a parse failure or any substitution can never be allowed
  const forceAsk = parsed.parseError || parsed.hasSubstitution;

  let sawAsk = forceAsk;
  let allAllowed = !parsed.parseError && parsed.roots.length > 0;
  // an exact grant is tested after the deny pass of the prefix rules and speaks only when they have no opinion
  const exact = exactRuleFor(rules, parsed.raw);
  if (exact?.effect === 'deny') return 'deny';

  for (const root of parsed.roots) {
    // Match the full invocation string first, then fall back to the bare basename. Keeping the two
    // results distinct is what powers the shadow guard below: byArgv saw the path, byName didn't.
    const byArgv = effectFor(rules, root.argv.join(' '));
    const byName = effectFor(rules, root.name);
    // a deny found by any reading of the invocation wins, even over an allow found by another
    if (
      byArgv === 'deny' ||
      byName === 'deny' ||
      effectFor(rules, namedInvocation(root)) === 'deny'
    ) {
      return 'deny'; // deny short-circuits, beats any specific allow
    }
    const effect = byArgv ?? byName ?? exact?.effect;
    if (root.opaque === true) {
      sawAsk = true;
      allAllowed = false;
      continue;
    }

    // A stdin-fed runner (xargs) launders its real target through pipeline stdin — invisible to the
    // name-based floor and to any allow rule — so treat it exactly like an opaque spawner: even an
    // explicit `allow xargs` cannot auto-run it; it always reaches the human (never YOLO-lifted).
    if (STDIN_RUNNERS.has(root.name)) {
      sawAsk = true;
      allAllowed = false;
      continue;
    }

    // trusted-basename: an allow that matched ONLY the basename (byName, not the full invocation
    // byArgv) must NOT auto-approve a path-qualified binary — a PATH-shadow/copy off the trusted
    // basename would otherwise inherit the grant. An explicit-path allow rule matches byArgv (it saw
    // the path), so it still stands.
    const basenameOnlyAllow = byArgv === undefined && byName === 'allow';
    if (basenameOnlyAllow && isQualifiedPath(root.argv[0] ?? '')) {
      sawAsk = true;
      allAllowed = false;
      continue;
    }

    // per-tool arg semantics: a safelisted tool's allow does not extend to an invocation whose
    // flags/args subvert it — a git global-option hijack or an ffmpeg network-protocol input both
    // downgrade to ask (the human confirms). deny already short-circuited above, so this only ever
    // tightens an allow, never loosens.
    if (effect === 'allow' && unsafeToolArgs(root)) {
      sawAsk = true;
      allAllowed = false;
      continue;
    }

    // grant-identity binding: an allow won by an identity-bearing grant only stands if argv[0] STILL
    // resolves to the realpath the grant was approved for. A mid-session $PATH/symlink swap
    // (ffmpeg -> /tmp/evil/ffmpeg) resolves elsewhere -> downgrade allow->ask (never deny; deny-first
    // and the hard floor are untouched). Catches an explicit-path grant whose symlink was swapped too,
    // which the lexical test never sees. Name-only grants have no identity and are unaffected.
    if (effect === 'allow' && identityMismatch(root, rules, resolveExecutable, parsed.raw)) {
      sawAsk = true;
      allAllowed = false;
      continue;
    }

    if (effect === 'ask') {
      sawAsk = true;
      allAllowed = false;
    }
    if (effect !== 'allow') allAllowed = false; // no rule => not allowed => ask
  }

  if (sawAsk) return 'ask';
  return allAllowed ? 'allow' : 'ask';
}

// The rule that caused a 'deny' verdict, for the engine's deny reason (replaces the bare "denied by
// rule"). Mirrors resolveStatic's byArgv-then-byName precedence and first-root-wins short-circuit
// above via the SAME matchedRule primitive, so it can never name a different rule than the one
// resolveStatic's 'deny' actually came from. Callers invoke this only after resolveStatic has
// already returned 'deny' for this exact (parsed, rules) pair.
export function denyRuleFor(parsed: ParsedCommand, rules: RuleSet): PermissionRule | undefined {
  const exact = exactRuleFor(rules, parsed.raw);
  if (exact?.effect === 'deny') return exact;
  for (const root of parsed.roots) {
    for (const value of [root.argv.join(' '), namedInvocation(root), root.name]) {
      const rule = matchedRule(rules, value);
      if (rule?.effect === 'deny') return rule;
    }
  }
  return undefined;
}
