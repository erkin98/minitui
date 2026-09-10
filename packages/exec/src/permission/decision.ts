import type { ParsedCommand, CommandRoot, PermissionRule } from '@minitui/types';
import { effectFor, matchedRule, type RuleSet } from './rules.js';
import { OPAQUE_SPAWNERS, STDIN_RUNNERS, isQualifiedPath } from './shell/wrappers.js';
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

// ffmpeg/ffprobe network-protocol input — the canonical ffmpeg SSRF/exfil vector. A local-transcode
// grant must NOT auto-cover an argument that turns ffmpeg into a network client (`-i http://…`,
// `rtmp://…`). curl/wget stay in the non-overridable hard-floor because they are PURELY network
// tools; ffmpeg is a legitimate local tool that CAN fetch, so a URL argument downgrades to ask (the
// human confirms the fetch) rather than a hard deny.
const NET_SCHEME =
  /^(https?|ftps?|rtmps?|rtsp|rtp|sctp|srt|tcp|udp|tls|gopher|sftp|scp|smb|telnet|dict):\/\//i;

function ffmpegNetworkInput(root: CommandRoot): boolean {
  if (root.name !== 'ffmpeg' && root.name !== 'ffprobe') return false;
  return root.argv.some((a) => NET_SCHEME.test(a));
}

// Exported so the ENGINE can treat an unsafe-tool-arg invocation as NON-YOLO-upgradable:
// resolveStatic downgrades allow->ask here, and the engine additionally refuses to let YOLO lift
// that ask — an `ask` YOLO override would defeat the downgrade (git global-opt / ffmpeg SSRF).
export function unsafeToolArgs(root: CommandRoot): boolean {
  return gitGlobalOptionUnsafe(root) || ffmpegNetworkInput(root);
}

// grant-identity binding. True when an `allow` for this root is won by an identity-bearing grant
// (`.identity` = the realpath captured at mint) whose bound realpath no longer equals what `argv[0]`
// resolves to NOW — a mid-session $PATH/symlink swap of a same-basename binary. Mirrors resolveStatic's
// byArgv-then-byName precedence via the SAME matchedRule primitive, so the rule it reads can never
// disagree with the effect resolveStatic saw. Name-only grants (operator config, legacy) return false
// — today's match is unchanged. Exported so the engine can add it to the NON-YOLO-liftable `uncertain`
// set (a resolved identity the host cannot vouch for is host-uncertainty, must reach the human even
// under YOLO).
export function identityMismatch(
  root: CommandRoot,
  rules: RuleSet,
  resolveExecutable: ResolveExecutable,
): boolean {
  const matched = matchedRule(rules, root.argv.join(' ')) ?? matchedRule(rules, root.name);
  if (matched?.effect !== 'allow' || matched.identity === undefined) return false;
  return resolveExecutable(root.argv[0] ?? root.name) !== matched.identity;
}

// Deny-first triad over a parsed command. Order is FIXED and specificity never reorders it:
//   any deny       -> deny
//   else any reason to ask (parse error, substitution, opaque spawner, missing allow) -> ask
//   else (all roots explicitly allowed, nothing forces ask) -> allow
//
// opaque-spawner is re-derived here from the root NAME — the canonical CommandRoot wire shape
// carries only {name, argv}, so `sh`/`eval`/`source` as a gated root name forces ask even if a
// rule allows that spawner (the quoted payload is unparseable, never strip-and-trust).
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

  for (const root of parsed.roots) {
    // Match the full invocation string first, then fall back to the bare basename. Keeping the two
    // results distinct is what powers the shadow guard below: byArgv saw the path, byName didn't.
    const byArgv = effectFor(rules, root.argv.join(' '));
    const byName = effectFor(rules, root.name);
    const effect = byArgv ?? byName;
    if (effect === 'deny') return 'deny'; // deny short-circuits, beats any specific allow
    if (OPAQUE_SPAWNERS.has(root.name)) {
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
    if (effect === 'allow' && identityMismatch(root, rules, resolveExecutable)) {
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
  for (const root of parsed.roots) {
    const rule = matchedRule(rules, root.argv.join(' ')) ?? matchedRule(rules, root.name);
    if (rule?.effect === 'deny') return rule;
  }
  return undefined;
}
