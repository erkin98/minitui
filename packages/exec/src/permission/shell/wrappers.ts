import { basename } from 'node:path';
import { foldCase } from './host.js';

// Opaque shell-spawners: the real payload is a quoted string the AST cannot see.
// We gate the SPAWNER itself and force ask — we never strip-and-trust the inner string.
// The second half of the list holds shells, command-string builtins and runners the option tables
// below do not model: their inner command cannot be located reliably, so they are not peeled.
// `compgen` is there because its `-W` word list and its `-C` command are run like `eval` text.
export const OPAQUE_SPAWNERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'ksh',
  'zsh',
  'eval',
  'source',
  '.',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'busybox',
  'su',
  'script',
  'hash',
  'trap',
  'alias',
  'flock',
  'taskset',
  'chrt',
  'nsenter',
  'runuser',
  'setpriv',
  'fakeroot',
  'proxychains',
  'proxychains4',
  'strace',
  'ltrace',
  'watch',
  'systemd-run',
  'parallel',
  'compgen',
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
  // a coprocess runs an inner command: peel to it so the floor judges the real target
  'coproc',
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

// A wrapper the peel went through: its name, the argv it was written with (from the wrapper onward),
// and whether one of its options is outside the tables below.
export interface PeeledWrapper {
  readonly name: string;
  readonly full: readonly string[];
  readonly unmodelled: boolean;
}

interface Unwrapped {
  readonly name: string;
  readonly argv: readonly string[];
  readonly wrappedBy: readonly string[];
  readonly peeled: readonly PeeledWrapper[];
  // an assignment word the peel skipped (`env PATH=/tmp/evil ffmpeg`): it changes what the inner command runs
  readonly skippedAssignment: boolean;
  // a wrapper's own option gave the wrapped command another working directory or another root, so a
  // relative operand of that command names a place the host cannot see
  readonly setsDirectory: boolean;
  readonly opaque: boolean;
}

// What the peel knows about one arg-runner's options: those that take an operand, and those that take
// none. An option in neither set is UNMODELLED: the peel cannot tell whether it swallows the next
// token, so the inner command is marked opaque and the wrapper's whole argv reaches the floor. Boolean
// flags are tabled, so `sudo -E ls`, `env -i ls` and `time -p ls` keep their verdicts. `--opt=val` and
// an attached short form (`-oVAL`) carry the operand inline and never consume the next token.
interface OptionTable {
  readonly operand: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
}

const table = (operand: readonly string[], flags: readonly string[] = []): OptionTable => ({
  operand: new Set(operand),
  flags: new Set(flags),
});

// Options that turn the text after them into a command string are absent on purpose, so the peel reads
// them as unmodelled and marks the root opaque: `sudo -s`, `-i`, `--shell` and `--login` hand the rest
// of the line to a shell, `env -S` and `--split-string` and `npx -c` and `--call` run the string they take.
const OPTIONS: Readonly<Record<string, OptionTable>> = {
  sudo: table(
    [
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
    ],
    [
      '-A',
      '-b',
      '-E',
      '-e',
      '-H',
      '-K',
      '-k',
      '-l',
      '-n',
      '-P',
      '-S',
      '-V',
      '-v',
      '--askpass',
      '--background',
      '--preserve-env',
      '--edit',
      '--set-home',
      '--remove-timestamp',
      '--reset-timestamp',
      '--list',
      '--non-interactive',
      '--preserve-groups',
      '--stdin',
      '--validate',
      '--version',
      '--help',
    ],
  ),
  env: table(
    ['-u', '--unset', '-C', '--chdir', '-P'],
    ['-i', '-0', '-v', '--ignore-environment', '--null', '--debug', '--version', '--help'],
  ),
  doas: table(['-u', '-C'], ['-n', '-s', '-L']),
  timeout: table(
    ['-s', '--signal', '-k', '--kill-after'],
    ['--foreground', '--preserve-status', '-v', '--verbose', '--version', '--help'],
  ),
  nice: table(['-n', '--adjustment'], ['--version', '--help']),
  nohup: table([], ['--version', '--help']),
  setsid: table(
    [],
    ['-c', '--ctty', '-f', '--fork', '-w', '--wait', '-V', '--version', '-h', '--help'],
  ),
  stdbuf: table(['-i', '--input', '-o', '--output', '-e', '--error'], ['--version', '--help']),
  time: table(
    ['-o', '--output', '-f', '--format'],
    ['-p', '-a', '--append', '-v', '--verbose', '-V', '--version', '--portability', '--help'],
  ),
  ionice: table(
    ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
    ['-t', '--ignore', '--version', '--help'],
  ),
  chroot: table(['--userspec', '--groups'], ['--skip-chdir', '--version', '--help']),
  unshare: table(
    ['-S', '--setuid', '-G', '--setgid', '-R', '--root', '-w', '--wd'],
    [
      '-m',
      '-u',
      '-i',
      '-n',
      '-p',
      '-U',
      '-C',
      '-T',
      '-f',
      '-r',
      '--mount',
      '--uts',
      '--ipc',
      '--net',
      '--pid',
      '--user',
      '--cgroup',
      '--time',
      '--fork',
      '--map-root-user',
      '--kill-child',
      '--mount-proc',
      '--version',
      '--help',
    ],
  ),
  npx: table(
    ['-p', '--package'],
    ['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--version', '--help'],
  ),
  docker: table([]),
  exec: table(['-a'], ['-c', '-l']),
  command: table([], ['-p', '-v', '-V']),
  builtin: table([]),
  coproc: table([]),
};

// Arg-runners taking a fixed count of leading POSITIONAL operands BEFORE the inner command
// (`timeout DURATION cmd`, `chroot NEWROOT cmd`). Without this, `timeout 5 rm -rf /` would root at
// `5` and the hard floor would never see the rm. NOTE `docker` (subcommand + image positional
// grammar) is deliberately NOT modeled: its inner command runs inside the container, not on the
// host, so mis-rooting it to `run` is host-safe and the OS sandbox is the real containment; a
// host-affecting `docker run -v /:/host …` is a mount escape beyond argv parsing.
const LEADING_POSITIONALS: Record<string, number> = { timeout: 1, chroot: 1 };

// Runners that skip `NAME=value` words before the inner command, as `env` does.
const SKIPS_ASSIGNMENTS: ReadonlySet<string> = new Set(['env', 'sudo']);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The options that give the wrapped command another working directory or another root. For `sudo` the
// letter `-C` is `--close-from`, which changes no directory, so only `env` lists it.
const DIRECTORY_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['-C', '--chdir']),
  sudo: new Set(['-D', '--chdir', '-R', '--chroot']),
  unshare: new Set(['-w', '--wd', '-R', '--root']),
};

interface OptionRead {
  // tokens the option takes, itself included
  readonly consumed: number;
  readonly unmodelled: boolean;
  // the option sets the working directory or the root of the wrapped command
  readonly directory: boolean;
}

function readLongOption(
  opts: OptionTable,
  dirs: ReadonlySet<string> | undefined,
  tok: string,
): OptionRead {
  const eq = tok.indexOf('=');
  const name = eq === -1 ? tok : tok.slice(0, eq);
  if (!opts.operand.has(name) && !opts.flags.has(name)) {
    return { consumed: 1, unmodelled: true, directory: false };
  }
  return {
    consumed: eq === -1 && opts.operand.has(name) ? 2 : 1,
    unmodelled: false,
    directory: dirs?.has(name) === true,
  };
}

// A cluster of short flags (`-nu root`): each character is a flag, or an option that takes an operand.
// An operand-taking character that ends the cluster takes the NEXT token; with characters after it,
// they are the attached operand (`-uroot`).
function readShortCluster(
  opts: OptionTable,
  dirs: ReadonlySet<string> | undefined,
  tok: string,
): OptionRead {
  for (let k = 1; k < tok.length; k++) {
    const opt = `-${tok[k]}`;
    if (opts.operand.has(opt)) {
      return {
        consumed: k === tok.length - 1 ? 2 : 1,
        unmodelled: false,
        directory: dirs?.has(opt) === true,
      };
    }
    if (!opts.flags.has(opt)) return { consumed: 1, unmodelled: true, directory: false };
  }
  return { consumed: 1, unmodelled: false, directory: false };
}

function readOption(runner: string, tok: string): OptionRead {
  const opts = OPTIONS[runner];
  if (opts === undefined) return { consumed: 1, unmodelled: true, directory: false };
  const dirs = DIRECTORY_OPTIONS[runner];
  if (tok.startsWith('--')) return readLongOption(opts, dirs, tok);
  if (runner === 'nice' && /^-[0-9]+$/.test(tok)) {
    return { consumed: 1, unmodelled: false, directory: false };
  }
  return readShortCluster(opts, dirs, tok);
}

// Skip an arg-runner's own options — and, for an option that takes an operand, its operand token —
// then a fixed count of leading positional operands, to find the start of the inner argv. This is
// the hard-floor's anti-mis-rooting guard: an option's operand (or a positional like `timeout`'s
// DURATION) must never be mistaken for the inner command, which would hide a gated `rm`/`curl`.
function innerStart(
  runner: string,
  rest: readonly string[],
): {
  readonly start: number;
  readonly unmodelled: boolean;
  readonly skipped: boolean;
  readonly directory: boolean;
} {
  let i = 0;
  let unmodelled = false;
  let skipped = false;
  let directory = false;
  while (i < rest.length) {
    const tok = rest[i]!;
    if (SKIPS_ASSIGNMENTS.has(runner) && ASSIGNMENT_WORD.test(tok)) {
      i++;
      skipped = true;
      continue;
    }
    if (tok === '-' && runner === 'env') {
      i++; // a lone dash is a flag of env, not the inner command
      continue;
    }
    if (!tok.startsWith('-') || tok === '-') break; // first positional (`-` is a stdin sentinel)
    if (tok === '--') {
      i++;
      break;
    } // explicit end-of-options
    const option = readOption(runner, tok);
    unmodelled ||= option.unmodelled;
    directory ||= option.directory;
    i += option.consumed;
  }
  const positionals = LEADING_POSITIONALS[runner] ?? 0;
  for (let p = 0; p < positionals && i < rest.length; p++) i++;
  return { start: i, unmodelled, skipped, directory };
}

// `fold` makes the name matching case-insensitive, for a host whose file system is (darwin, win32).
export function unwrapArgv(argv: readonly string[], fold = false): Unwrapped {
  const wrappedBy: string[] = [];
  const peeled: PeeledWrapper[] = [];
  let anyUnmodelled = false;
  let anySkipped = false;
  let anyDirectory = false;
  let cur = argv;
  // peel arg-runners until we reach a real command or an opaque spawner
  for (;;) {
    // normalise THEN basename so `"/bin/curl"` / `\curl` / `'sh'` resolve to their bare name
    const written = basename(normalizeCommandToken(cur[0] ?? ''));
    const head = fold ? foldCase(written) : written;
    if (OPAQUE_SPAWNERS.has(head)) {
      return {
        name: head,
        argv: cur,
        wrappedBy,
        peeled,
        skippedAssignment: anySkipped,
        setsDirectory: anyDirectory,
        opaque: true,
      };
    }
    if (ARG_RUNNERS.has(head)) {
      const rest = cur.slice(1);
      const { start, unmodelled, skipped, directory } = innerStart(head, rest);
      const inner = rest.slice(start);
      if (inner.length === 0) {
        // wrapper with no inner command (e.g. bare `sudo`) — opaque, force ask
        return {
          name: head,
          argv: cur,
          wrappedBy,
          peeled,
          skippedAssignment: anySkipped,
          setsDirectory: anyDirectory,
          opaque: true,
        };
      }
      wrappedBy.push(head);
      peeled.push({ name: head, full: cur, unmodelled });
      anyUnmodelled ||= unmodelled;
      anySkipped ||= skipped;
      anyDirectory ||= directory;
      cur = inner;
      continue;
    }
    // an option the tables do not model leaves the inner command unlocated: it is opaque, and the
    // floor still reads every later token of the wrapper's own argv as a candidate command name
    return {
      name: head,
      argv: cur,
      wrappedBy,
      peeled,
      skippedAssignment: anySkipped,
      setsDirectory: anyDirectory,
      opaque: anyUnmodelled,
    };
  }
}
