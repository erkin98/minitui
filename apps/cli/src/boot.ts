// Environment detection, the log file and terminal restore for the bin. This file imports no @minitui
// package: it must stay loadable and testable on its own, and it is what runs when everything else has
// already failed.
import { closeSync, constants, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

export interface BootEnv {
  /** Both stdin and stdout are terminals: the only state in which the interactive app may start. */
  readonly isInteractive: boolean;
  readonly logPath: string;
}

export interface DetectInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutIsTTY?: boolean;
  readonly stdinIsTTY?: boolean;
  readonly platform?: NodeJS.Platform;
}

// A state directory taken from the environment must be absolute: an empty or relative value would put
// the log in whatever directory the program happens to run in.
function absoluteOrUndefined(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  return (platform === 'win32' ? win32 : posix).isAbsolute(value) ? value : undefined;
}

// The platform's own place for logs: darwin gets Library/Logs, win32 gets LOCALAPPDATA, the rest get XDG.
function resolveLogPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix;
  const home = homedir();
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Logs')
      : platform === 'win32'
        ? (absoluteOrUndefined(env.LOCALAPPDATA, platform) ?? path.join(home, 'AppData', 'Local'))
        : (absoluteOrUndefined(env.XDG_STATE_HOME, platform) ?? path.join(home, '.local', 'state'));
  return path.join(base, 'minitui', 'minitui.log');
}

export function detectEnv(input: DetectInput = {}): BootEnv {
  const env = input.env ?? process.env;
  const stdoutIsTTY = input.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const stdinIsTTY = input.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  return {
    isInteractive: stdoutIsTTY && stdinIsTTY,
    logPath: resolveLogPath(env, input.platform ?? process.platform),
  };
}

export interface LogWriter {
  write(line: string): void;
  close(): void;
}

const NOOP_WRITER: LogWriter = { write: () => {}, close: () => {} };

/**
 * Appends to the log with 0600 permissions (a log can hold paths and request text, so it is never world
 * readable) and fails closed: any filesystem error gives a writer that does nothing, because a logging
 * failure must never take the program down.
 */
export function openLogFile(path: string): LogWriter {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    // The mode given to openSync applies only when the file is created, so tighten an existing one too.
    fchmodSync(fd, 0o600);
    const openFd = fd;
    return {
      write(line: string): void {
        try {
          writeSync(openFd, `${line}\n`);
        } catch {
          // a failed log write is dropped
        }
      },
      close(): void {
        try {
          closeSync(openFd);
        } catch {
          // already closed
        }
      },
    };
  } catch {
    // A failure after openSync (fchmodSync, say) must not leak the descriptor.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    return NOOP_WRITER;
  }
}

/**
 * The diagnostics sink the composition root injects: one JSON line per record over the log writer. The
 * returned shape is the DiagnosticsPort of @minitui/types, kept structural here so this file imports no
 * package. `msg` is a fixed phrase written by the producer; anything derived from input travels in `meta`,
 * which may be any value, so the serialisation is total: a bigint, a cycle or a `toJSON` that throws still
 * produces a record. The finished line goes through `scrub` before it is written, because JSON escaping
 * leaves DEL and the C1 range raw and a terminal would act on them, and because a caller can use it to
 * remove a secret. The sanitiser is injected since this file cannot import one.
 */
export function createFileDiagnostics(
  log: LogWriter,
  scrub: (line: string) => string = (line) => line,
): {
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
} {
  // A fresh `seen` set per record: an object met twice in one record prints `[circular]`.
  const stringify = (record: unknown): string => {
    const seen = new WeakSet<object>();
    try {
      return (
        JSON.stringify(record, (_key, value: unknown) => {
          if (typeof value === 'bigint') return `${value}n`;
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
          }
          return value;
        }) ?? '"[unserialisable]"'
      );
    } catch {
      return '"[unserialisable]"';
    }
  };
  const emit = (level: 'warn' | 'debug', msg: string, meta?: Record<string, unknown>): void =>
    log.write(scrub(stringify(meta ? { level, msg, meta } : { level, msg })));
  return {
    warn: (msg, meta) => emit('warn', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
  };
}

const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const SHOW_CURSOR = '\x1b[?25h';
const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const CRASH_FALLBACK = 'unexpected failure';

export type TerminatingSignal = (typeof TERMINATING_SIGNALS)[number];

/** What terminal restore needs from the process, so a test can drive every exit path by hand. */
export interface ProcessPort {
  readonly pid: number;
  onExit(listener: () => void): void;
  onSignal(signal: TerminatingSignal, listener: () => void): void;
  onCrash(listener: (reason: unknown) => void): void;
  raise(signal: TerminatingSignal): void;
  exit(code: number): void;
}

export const realProcess: ProcessPort = {
  pid: process.pid,
  onExit: (listener) => {
    process.once('exit', listener);
  },
  onSignal: (signal, listener) => {
    process.once(signal, listener);
  },
  onCrash: (listener) => {
    process.once('uncaughtException', listener);
    process.once('unhandledRejection', listener);
  },
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
  exit: (code) => process.exit(code),
};

export interface RestoreOptions {
  readonly out?: { write(s: string): void } | undefined;
  readonly err?: { write(s: string): void } | undefined;
  readonly proc?: ProcessPort | undefined;
  /**
   * Turns the text of a crash into what may reach the terminal. The caller sanitises and bounds it: a
   * crash message can carry text from a provider, a file or the model, and a terminal acts on escapes.
   */
  readonly formatCrash: (text: string) => string;
}

export interface TerminalRestoreHandle {
  /** Idempotent: runs the cancel hook, then the restore write, exactly once across every exit path. */
  restore(): void;
  /** The renderer marks that it entered the alternate screen; restore leaves it only then. */
  markAltScreen(entered: boolean): void;
  /** One hook that runs before the terminal is touched; the entry wires the run graph's cancel to it. */
  onBeforeExit(hook: () => void): void;
}

function crashText(reason: unknown, format: (text: string) => string): string {
  try {
    return format(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  } catch {
    return CRASH_FALLBACK;
  }
}

/**
 * Registers a restore of the terminal on every way out: the exit event, a terminating signal (re-raised
 * after the restore so the shell sees the real 128+n status) and a crash that no try/finally catches (an
 * uncaught throw or a rejection in a detached callback). The signal and crash paths run the cancel hook
 * synchronously and cannot wait for asynchronous teardown such as the sandbox disposal; the normal path
 * in the entry does that before it calls `restore`.
 */
export function registerTerminalRestore(options: RestoreOptions): TerminalRestoreHandle {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const proc = options.proc ?? realProcess;
  let done = false;
  let altScreen = false;
  let hook: (() => void) | undefined;

  const restore = (): void => {
    if (done) return;
    done = true;
    const cancel = hook;
    hook = undefined;
    try {
      cancel?.();
    } catch {
      // a failing cancel must never keep the terminal from being restored
    }
    try {
      out.write(`${altScreen ? LEAVE_ALT_SCREEN : ''}${SHOW_CURSOR}`);
    } catch {
      // stdout may be closed at crash time; the restore is best effort
    }
  };

  proc.onExit(restore);
  for (const signal of TERMINATING_SIGNALS) {
    proc.onSignal(signal, () => {
      restore();
      proc.raise(signal);
    });
  }
  proc.onCrash((reason) => {
    restore();
    try {
      err.write(`${crashText(reason, options.formatCrash)}\n`);
    } catch {
      // stderr may be closed too
    }
    proc.exit(1);
  });

  return {
    restore,
    markAltScreen(entered) {
      altScreen = entered;
    },
    onBeforeExit(next) {
      hook = next;
    },
  };
}
