import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileDiagnostics,
  detectEnv,
  openLogFile,
  registerTerminalRestore,
  type ProcessPort,
  type TerminatingSignal,
} from '../src/boot.js';

describe('detectEnv: interactive', () => {
  it('is interactive only when both streams are terminals', () => {
    expect(detectEnv({ env: {}, stdoutIsTTY: true, stdinIsTTY: true }).isInteractive).toBe(true);
    expect(detectEnv({ env: {}, stdoutIsTTY: true, stdinIsTTY: false }).isInteractive).toBe(false);
    expect(detectEnv({ env: {}, stdoutIsTTY: false, stdinIsTTY: true }).isInteractive).toBe(false);
    expect(detectEnv({ env: {}, stdoutIsTTY: false, stdinIsTTY: false }).isInteractive).toBe(false);
  });
});

describe('detectEnv: platform-aware log path', () => {
  it('linux: an absolute XDG_STATE_HOME wins', () => {
    const env = detectEnv({ env: { XDG_STATE_HOME: '/xdg/state' }, platform: 'linux' });
    expect(env.logPath).toBe('/xdg/state/minitui/minitui.log');
  });

  it('linux: without XDG_STATE_HOME the log goes under ~/.local/state', () => {
    const env = detectEnv({ env: {}, platform: 'linux' });
    expect(env.logPath).toMatch(/\.local\/state\/minitui\/minitui\.log$/);
  });

  it('linux: an empty or relative XDG_STATE_HOME is ignored, so the log never lands in the working directory', () => {
    for (const bad of ['', 'state', './state']) {
      const env = detectEnv({ env: { XDG_STATE_HOME: bad }, platform: 'linux' });
      expect(env.logPath).toMatch(/\.local\/state\/minitui\/minitui\.log$/);
    }
  });

  it('darwin: ~/Library/Logs, never XDG-shaped', () => {
    const env = detectEnv({ env: { XDG_STATE_HOME: '/xdg/state' }, platform: 'darwin' });
    expect(env.logPath).toMatch(/Library\/Logs\/minitui\/minitui\.log$/);
  });

  it('win32: %LOCALAPPDATA%, with the Windows separator', () => {
    const env = detectEnv({
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      platform: 'win32',
    });
    expect(env.logPath).toBe('C:\\Users\\u\\AppData\\Local\\minitui\\minitui.log');
  });

  it('win32: a missing or empty LOCALAPPDATA falls back under the home directory', () => {
    for (const env of [{}, { LOCALAPPDATA: '' }]) {
      expect(detectEnv({ env, platform: 'win32' }).logPath).toMatch(
        /AppData\\Local\\minitui\\minitui\.log$/,
      );
    }
  });
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'minitui-boot-'));

describe('openLogFile', () => {
  it('appends lines and writes with 0600 permissions, creating the directory', () => {
    const path = join(tmp(), 'sub', 'minitui.log');
    const log = openLogFile(path);
    log.write('first');
    log.write('second');
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens a log file that already exists with looser permissions', () => {
    const path = join(tmp(), 'minitui.log');
    writeFileSync(path, '', { mode: 0o644 });
    const log = openLogFile(path);
    log.write('first');
    log.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('fails silent on an unwritable path and never throws', () => {
    const blocker = join(tmp(), 'a-file');
    writeFileSync(blocker, '');
    const log = openLogFile(join(blocker, 'sub', 'minitui.log'));
    expect(() => log.write('x')).not.toThrow();
    expect(() => log.close()).not.toThrow();
  });
});

describe('createFileDiagnostics', () => {
  const lines = (path: string): unknown[] =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);

  it('writes one JSON line per record, with the meta omitted when absent', () => {
    const path = join(tmp(), 'minitui.log');
    const log = openLogFile(path);
    const diag = createFileDiagnostics(log);
    diag.warn('queue drop', { dropped: 3 });
    diag.debug('discovery skipped');
    log.close();
    expect(lines(path)).toEqual([
      { level: 'warn', msg: 'queue drop', meta: { dropped: 3 } },
      { level: 'debug', msg: 'discovery skipped' },
    ]);
  });

  it('is total over the meta: a bigint, a cycle and a throwing toJSON still land as a record', () => {
    const path = join(tmp(), 'minitui.log');
    const log = openLogFile(path);
    const diag = createFileDiagnostics(log);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    diag.warn('big', { n: 5n });
    diag.warn('cycle', { cyclic });
    diag.warn('throws', {
      toJSON: () => {
        throw new Error('boom');
      },
    });
    log.close();
    const written = lines(path);
    expect(written).toHaveLength(3);
    expect(written[0]).toEqual({ level: 'warn', msg: 'big', meta: { n: '5n' } });
    expect(written[1]).toEqual({
      level: 'warn',
      msg: 'cycle',
      meta: { cyclic: { self: '[circular]' } },
    });
    expect(written[2]).toEqual('[unserialisable]');
  });

  it('passes every finished line through the scrub, so a secret in the meta never reaches the file', () => {
    const path = join(tmp(), 'minitui.log');
    const log = openLogFile(path);
    const diag = createFileDiagnostics(log, (line) => line.replaceAll('sk-secret', '[redacted]'));
    diag.warn('call failed', { detail: { header: 'Bearer sk-secret' } });
    log.close();
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('sk-secret');
    expect(text).toContain('[redacted]');
    // the same record without the scrub carries it: the row above can fail
    const bare = join(tmp(), 'bare.log');
    const bareLog = openLogFile(bare);
    createFileDiagnostics(bareLog).warn('call failed', { detail: { header: 'Bearer sk-secret' } });
    bareLog.close();
    expect(readFileSync(bare, 'utf8')).toContain('sk-secret');
  });

  it('never throws when the log writer is the fail-closed no-op', () => {
    const blocker = join(tmp(), 'a-file');
    writeFileSync(blocker, '');
    const diag = createFileDiagnostics(openLogFile(join(blocker, 'x.log')));
    expect(() => diag.warn('x', { a: 1 })).not.toThrow();
  });
});

// A real implementation of the process port that records what the restore registered and lets a test
// fire each event by hand.
function fakeProcess(): {
  proc: ProcessPort;
  fireExit: () => void;
  fireSignal: (signal: TerminatingSignal) => void;
  fireCrash: (reason: unknown) => void;
  events: string[];
  signals: TerminatingSignal[];
  exits: number[];
} {
  const events: string[] = [];
  const exitListeners: Array<() => void> = [];
  const signalListeners = new Map<TerminatingSignal, Array<() => void>>();
  const crashListeners: Array<(reason: unknown) => void> = [];
  const signals: TerminatingSignal[] = [];
  const exits: number[] = [];
  const proc: ProcessPort = {
    pid: 4242,
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    onSignal: (signal, listener) => {
      signals.push(signal);
      signalListeners.set(signal, [...(signalListeners.get(signal) ?? []), listener]);
    },
    onCrash: (listener) => {
      crashListeners.push(listener);
    },
    raise: (signal) => {
      events.push(`raise:${signal}`);
    },
    exit: (code) => {
      events.push(`exit:${code}`);
      exits.push(code);
    },
  };
  return {
    proc,
    fireExit: () => exitListeners.forEach((listener) => listener()),
    fireSignal: (signal) => signalListeners.get(signal)?.forEach((listener) => listener()),
    fireCrash: (reason) => crashListeners.forEach((listener) => listener(reason)),
    events,
    signals,
    exits,
  };
}

const ESC = String.fromCharCode(27);
const identity = (text: string): string => text;

describe('registerTerminalRestore', () => {
  it('shows the cursor exactly once and does not leave an alternate screen it never entered', () => {
    const writes: string[] = [];
    const term = registerTerminalRestore({
      out: { write: (s) => writes.push(s) },
      proc: fakeProcess().proc,
      formatCrash: identity,
    });
    term.restore();
    term.restore();
    expect(writes).toEqual([`${ESC}[?25h`]);
  });

  it('leaves the alternate screen only when the renderer marked it entered', () => {
    const writes: string[] = [];
    const term = registerTerminalRestore({
      out: { write: (s) => writes.push(s) },
      proc: fakeProcess().proc,
      formatCrash: identity,
    });
    term.markAltScreen(true);
    term.restore();
    expect(writes).toEqual([`${ESC}[?1049l${ESC}[?25h`]);
  });

  it('runs the cancel hook once, before the restore write', () => {
    const order: string[] = [];
    const term = registerTerminalRestore({
      out: { write: () => order.push('restore') },
      proc: fakeProcess().proc,
      formatCrash: identity,
    });
    term.onBeforeExit(() => order.push('cancel'));
    term.restore();
    term.restore();
    expect(order).toEqual(['cancel', 'restore']);
  });

  it('still restores when the cancel hook throws', () => {
    const writes: string[] = [];
    const term = registerTerminalRestore({
      out: { write: (s) => writes.push(s) },
      proc: fakeProcess().proc,
      formatCrash: identity,
    });
    term.onBeforeExit(() => {
      throw new Error('cancel failed');
    });
    expect(() => term.restore()).not.toThrow();
    expect(writes).toEqual([`${ESC}[?25h`]);
  });

  it('swallows a failing restore write, since stdout may be closed at crash time', () => {
    const term = registerTerminalRestore({
      out: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
      proc: fakeProcess().proc,
      formatCrash: identity,
    });
    expect(() => term.restore()).not.toThrow();
  });

  it('restores once across the exit event and a later signal', () => {
    const writes: string[] = [];
    const fake = fakeProcess();
    registerTerminalRestore({
      out: { write: (s) => writes.push(s) },
      proc: fake.proc,
      formatCrash: identity,
    });
    fake.fireExit();
    fake.fireSignal('SIGINT');
    expect(writes).toHaveLength(1);
  });

  it('registers for all three terminating signals', () => {
    const fake = fakeProcess();
    registerTerminalRestore({ out: { write: () => {} }, proc: fake.proc, formatCrash: identity });
    expect([...fake.signals].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
  });

  it('on a signal: cancels, restores, then re-raises the same signal', () => {
    const fake = fakeProcess();
    const term = registerTerminalRestore({
      out: { write: () => fake.events.push('restore') },
      proc: fake.proc,
      formatCrash: identity,
    });
    term.onBeforeExit(() => fake.events.push('cancel'));
    fake.fireSignal('SIGTERM');
    expect(fake.events).toEqual(['cancel', 'restore', 'raise:SIGTERM']);
  });
});

describe('registerTerminalRestore: crash path', () => {
  const sanitise = (text: string): string => text.replaceAll(ESC, '?').slice(0, 200);

  it('restores, writes the formatted stack to stderr, then exits 1', () => {
    const fake = fakeProcess();
    const err: string[] = [];
    registerTerminalRestore({
      out: { write: () => fake.events.push('restore') },
      err: { write: (s) => err.push(s) },
      proc: fake.proc,
      formatCrash: sanitise,
    });
    const crash = new Error(`bad ${ESC}[2J message`);
    fake.fireCrash(crash);
    expect(fake.events).toEqual(['restore', 'exit:1']);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('bad ?[2J message');
    expect(err[0]?.endsWith('\n')).toBe(true);
  });

  it('only the injected formatter keeps a terminal escape out of stderr', () => {
    const run = (formatCrash: (text: string) => string): string => {
      const fake = fakeProcess();
      const err: string[] = [];
      registerTerminalRestore({
        out: { write: () => {} },
        err: { write: (s) => err.push(s) },
        proc: fake.proc,
        formatCrash,
      });
      fake.fireCrash(new Error(`hostile ${ESC}[2J`));
      return err.join('');
    };
    expect(run(sanitise)).not.toContain(ESC);
    expect(run(identity)).toContain(ESC);
  });

  it('formats a non-Error reason with String()', () => {
    const fake = fakeProcess();
    const err: string[] = [];
    registerTerminalRestore({
      out: { write: () => {} },
      err: { write: (s) => err.push(s) },
      proc: fake.proc,
      formatCrash: identity,
    });
    fake.fireCrash('plain reason');
    expect(err).toEqual(['plain reason\n']);
  });

  it('uses a fixed line when the reason cannot be turned into text, and still exits 1', () => {
    const fake = fakeProcess();
    const err: string[] = [];
    registerTerminalRestore({
      out: { write: () => {} },
      err: { write: (s) => err.push(s) },
      proc: fake.proc,
      formatCrash: identity,
    });
    fake.fireCrash({
      toString: () => {
        throw new Error('no text');
      },
    });
    expect(err).toEqual(['unexpected failure\n']);
    expect(fake.exits).toEqual([1]);
  });

  it('uses the fixed line when the formatter itself throws', () => {
    const fake = fakeProcess();
    const err: string[] = [];
    registerTerminalRestore({
      out: { write: () => {} },
      err: { write: (s) => err.push(s) },
      proc: fake.proc,
      formatCrash: () => {
        throw new Error('format failed');
      },
    });
    fake.fireCrash(new Error('x'));
    expect(err).toEqual(['unexpected failure\n']);
    expect(fake.exits).toEqual([1]);
  });

  it('still exits 1 when stderr is closed', () => {
    const fake = fakeProcess();
    registerTerminalRestore({
      out: { write: () => {} },
      err: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
      proc: fake.proc,
      formatCrash: identity,
    });
    expect(() => fake.fireCrash(new Error('x'))).not.toThrow();
    expect(fake.exits).toEqual([1]);
  });
});
