import { basename } from 'node:path';

// Opaque shell-spawners: the real payload is a quoted string the AST cannot see.
// We gate the SPAWNER itself and force ask — we never strip-and-trust the inner string.
export const OPAQUE_SPAWNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'ksh',
  'zsh',
  'eval',
  'source',
  '.',
]);

// Arg-runners: take an inner argv we CAN re-resolve, so we peel the wrapper and gate the inner
// command. NOTE: `xargs` is intentionally absent — it feeds its inner command from pipeline STDIN
// (not from command-line argv), so peeling it would falsely claim to have gated the real target.
// An un-peeled xargs stays an unknown root and the decision triad asks.
export const ARG_RUNNERS: ReadonlySet<string> = new Set([
  'env',
  'sudo',
  'doas',
  'timeout',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'time',
  'ionice',
  'chroot',
  'unshare',
  'npx',
  'docker',
  // shell builtins that run an inner command — peel to the real target so `exec curl` /
  // `command curl` / `builtin cd` gate the inner command, not the builtin wrapper.
  'exec',
  'command',
  'builtin',
]);

// Stdin-fed runners: a recognized root whose INNER command/operand comes from pipeline STDIN, not
// argv, so the AST cannot see its real target (`echo / | xargs rm -rf` has no `rm` operand on the
// command line — the `/` is laundered through stdin, invisible to the name-based hard floor). They
// are never peeled (absent from ARG_RUNNERS, above) AND the engine must treat them as
// parser-uncertain so YOLO cannot lift them to allow — the target the floor would judge is unknowable.
// Keeping this a named set (not just "unknown root") makes the YOLO carve-out explicit.
export const STDIN_RUNNERS: ReadonlySet<string> = new Set(['xargs']);

// Normalise a command-name token before matching: tree-sitter returns the verbatim source slice,
// so `"curl"`, `'rm'` and `\curl` arrive with their quotes/escape intact and would slip past a
// bare-name egress/hard-floor match. Strip one leading backslash and one matching quote pair.
export function normalizeCommandToken(tok: string): string {
  let t = tok;
  if (t.startsWith('\\')) t = t.slice(1);
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    t = t.slice(1, -1);
  }
  return t;
}

// trusted-basename hardening: a bare-basename grant must NOT extend to an explicit-path invocation —
// a copied/symlinked/PATH-shadowed binary with the
// same basename does not inherit the rule. A command token is "path-qualified" when, after
// quote/escape normalization, it carries a path separator (`/tmp/ffmpeg`, `./ffmpeg`). The decision
// layer uses this to refuse to auto-allow a path-qualified root off a bare-name allow rule.
export function isQualifiedPath(token: string): boolean {
  return normalizeCommandToken(token).includes('/');
}

interface Unwrapped {
  readonly name: string;
  readonly argv: readonly string[];
  readonly wrappedBy: readonly string[];
  readonly opaque: boolean;
}

// Per-arg-runner options that consume the FOLLOWING token as their operand. A dashed token NOT in
// this table is a BOOLEAN flag (its successor is NOT consumed) — the secure default, because boolean
// flags (`sudo -k/-n/-b/-i/-H/-E`, `env -i/-0`, …) are common and swallowing the real inner command
// as a phantom operand would HIDE it from the hard floor (`sudo -u root rm -rf /` must still root at
// `rm`, not at the `-u` operand `root`). `--opt=val` and an attached short form (`-oVAL`) carry the
// operand inline and never consume the next token. Only a KNOWN value-option skips its successor;
// an unknown dashed arg just falls through as boolean.
const OPERAND_OPTS: Record<string, ReadonlySet<string>> = {
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-C',
    '--close-from',
    '-D',
    '--chdir',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-r',
    '--role',
    '-t',
    '--type',
    '-T',
    '--command-timeout',
    '-U',
    '--other-user',
    '-R',
    '--chroot',
  ]),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '-P']),
  doas: new Set(['-u', '-C', '-a']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  time: new Set(['-o', '--output', '-f', '--format']),
  unshare: new Set(['-S', '--setuid', '-G', '--setgid', '-R', '--root', '--wd']),
  npx: new Set(['-p', '--package', '-c', '--call']),
};

// Arg-runners taking a fixed count of leading POSITIONAL operands BEFORE the inner command
// (`timeout DURATION cmd`, `chroot NEWROOT cmd`). Without this, `timeout 5 rm -rf /` would root at
// `5` and the hard floor would never see the rm. NOTE `docker` (subcommand + image positional
// grammar) is deliberately NOT modeled: its inner command runs inside the container, not on the
// host, so mis-rooting it to `run` is host-safe and the OS sandbox is the real containment; a
// host-affecting `docker run -v /:/host …` is a mount escape beyond argv parsing (invariant (d)).
const LEADING_POSITIONALS: Record<string, number> = { timeout: 1, chroot: 1 };

// Does this runner's option token consume the FOLLOWING token as its operand? Only a KNOWN bare-form
// value-option does; `--opt=val` / attached `-oVAL` carry the operand inline, and any option not in
// the table is boolean (fail-safe: never swallow the real command).
function consumesNextOperand(runner: string, tok: string): boolean {
  const opts = OPERAND_OPTS[runner];
  if (!opts) return false;
  if (tok.includes('=')) return false; // --opt=val / -o=val: operand is inline
  if (tok.startsWith('--')) return opts.has(tok); // --long val: only a KNOWN long value-option
  if (tok.length > 2) return false; // -oVAL: short value-option, operand attached
  return opts.has(tok); // -o val: only a KNOWN short value-option
}

// Skip an arg-runner's own options — and, for a KNOWN operand-bearing option, its operand token —
// then a fixed count of leading positional operands, to find the start of the inner argv. This is
// the hard-floor's anti-mis-rooting guard: an option's operand (or a positional like `timeout`'s
// DURATION) must never be mistaken for the inner command, which would hide a gated `rm`/`curl`.
function innerStart(runner: string, rest: readonly string[]): number {
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i]!;
    if (runner === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    } // env NAME=val
    if (!tok.startsWith('-') || tok === '-') break; // first positional (`-` is a stdin sentinel)
    if (tok === '--') {
      i++;
      break;
    } // explicit end-of-options
    i += consumesNextOperand(runner, tok) ? 2 : 1;
  }
  const positionals = LEADING_POSITIONALS[runner] ?? 0;
  for (let p = 0; p < positionals && i < rest.length; p++) i++;
  return i;
}

export function unwrapArgv(argv: readonly string[]): Unwrapped {
  const wrappedBy: string[] = [];
  let cur = argv;
  // peel arg-runners until we reach a real command or an opaque spawner
  for (;;) {
    // normalise THEN basename so `"/bin/curl"` / `\curl` / `'sh'` resolve to their bare name
    const head = basename(normalizeCommandToken(cur[0] ?? ''));
    if (OPAQUE_SPAWNERS.has(head)) {
      return { name: head, argv: cur, wrappedBy, opaque: true };
    }
    if (ARG_RUNNERS.has(head)) {
      const rest = cur.slice(1);
      const start = innerStart(head, rest);
      const inner = rest.slice(start);
      if (inner.length === 0) {
        // wrapper with no inner command (e.g. bare `sudo`) — opaque, force ask
        return { name: head, argv: cur, wrappedBy, opaque: true };
      }
      wrappedBy.push(head);
      cur = inner;
      continue;
    }
    return { name: head, argv: cur, wrappedBy, opaque: false };
  }
}
