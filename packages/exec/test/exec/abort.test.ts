import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
// Import the runner from its OWN module, NOT the exec/ barrel — the barrel re-exports the
// ffmpeg and capabilities modules, which are written after this test, so importing it here would drag
// in modules that do not exist yet.
import { createLocalRunner, quoteCommand } from '../../src/exec/local-runner.js';
import { makeFfmpegProgressParser } from '../../src/exec/progress.js';
import { SandboxUnavailableError } from '../../src/errors.js';
import { checkHardFloor } from '../../src/permission/hard-floor.js';
import type { SpawnFn } from '../../src/exec/spawn-opts.js';
import type { SandboxManagerHandle, WrappedArgv } from '../../src/sandbox/index.js';
import type { RunnerEvent, RunSpec } from '../../src/types.js';
import type { DiagnosticsPort } from '@minitui/types';

const here = dirname(fileURLToPath(import.meta.url));
const EMIT = join(here, '..', 'fixtures', 'fake-bins', 'emit.mjs');
const policy = { allowWrite: [here], allowEgress: [] } as const;

// A REAL-shaped fake handle (the sandbox surface) — pass-through wrap, no `as never`. The shell double
// execs the program, so the direct child is the program on every /bin/sh (dash forks otherwise).
function fakeSandbox(overrides?: Partial<SandboxManagerHandle>): SandboxManagerHandle {
  return {
    probe: { supported: true, errors: [], warnings: [], platform: process.platform },
    active: true,
    wrapCommand: async (cmd) => cmd,
    wrapArgv: async (command: string) => ({
      argv: ['/bin/sh', '-c', `exec ${command}`],
      env: { ...process.env },
    }),
    violationsFor: async () => [],
    assertGatable: () => {},
    cleanup: () => {},
    dispose: async () => {},
    ...overrides,
  } satisfies SandboxManagerHandle;
}

// Exec-time re-gate: the runner re-gates the resolved argv[0] through the hard-floor before spawn. Pass-through
// by default; the re-gate test below injects a blocking one to prove the fail-closed backstop.
const passHardFloor = (): { blocked: boolean; reason?: string } => ({ blocked: false });

// A real child-process object that never spawns anything. It holds what the runner reads (pid, the two
// output streams, the exit state, kill), so the spawn doubles below need no cast to ChildProcess. The exit
// code is given and never null: the runner's orphan guard signals the group of a child that has not exited.
class FakeChild extends ChildProcess {
  override readonly pid: number | undefined;
  override stdout = null;
  override stderr = null;
  override readonly exitCode: number | null;
  override readonly signalCode = null;

  constructor(pid: number, exitCode: number) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
  }

  override kill(): boolean {
    return true;
  }
}

// A real child-process object with real output streams and no process behind it: the row writes whole 'data'
// events itself, so the byte boundaries of each read are exact (a pipe would pick them by timing).
class StreamChild extends ChildProcess {
  override readonly pid: number | undefined;
  override readonly stdout = new PassThrough();
  override readonly stderr = new PassThrough();
  override readonly exitCode: number | null;
  override readonly signalCode = null;

  constructor(pid: number, exitCode: number) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
  }

  override kill(): boolean {
    return true;
  }
}

async function collect(spec: RunSpec, signal: AbortSignal): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  const runner = createLocalRunner({ sandbox: fakeSandbox(), checkHardFloor: passHardFloor });
  for await (const ev of runner.run(spec, signal)) out.push(ev);
  return out;
}

async function drain(run: AsyncGenerator<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const ev of run) out.push(ev);
  return out;
}

// The pass-through shell wrap of fakeSandbox, and a wrap whose program dies on SIGTERM and otherwise sleeps.
const shellWrap = async (command: string): Promise<WrappedArgv> => ({
  argv: ['/bin/sh', '-c', `exec ${command}`],
  env: { ...process.env },
});
const SLEEPER: WrappedArgv = {
  argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
  env: { ...process.env },
};

// A handle that counts the wraps it handed out and the finished commands reported back to it. A wrap counts
// once it resolves: the runtime itself undoes a wrap that throws, so a rejected wrap must see no cleanup.
function countingSandbox(wrap: (command: string) => Promise<WrappedArgv>): {
  readonly sandbox: SandboxManagerHandle;
  readonly counts: () => { wraps: number; cleanups: number };
} {
  let wraps = 0;
  let cleanups = 0;
  const sandbox = fakeSandbox({
    wrapArgv: async (command: string) => {
      const wrapped = await wrap(command);
      wraps += 1;
      return wrapped;
    },
    cleanup: () => {
      cleanups += 1;
    },
  });
  return { sandbox, counts: () => ({ wraps, cleanups }) };
}

describe('createLocalRunner', () => {
  it('sanitizes stdout and yields started + exit', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'out:hello\u001b[31mRED\u001b[0m'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events = await collect(spec, new AbortController().signal);
    expect(events[0]?.kind).toBe('started');
    const stdout = events.find((e) => e.kind === 'stdout') as Extract<
      RunnerEvent,
      { kind: 'stdout' }
    >;
    expect(stdout.text).not.toContain('\u001b['); // ANSI stripped by the sanitizer
    expect(stdout.text).toContain('hello');
    expect(events.at(-1)!.kind).toBe('exit');
  });

  it('flushes the final unterminated chunk (no trailing newline) through the sanitizer at close', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'tail:tail\u001b[31m-no-newline'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events = await collect(spec, new AbortController().signal);
    const stdout = events.filter((e) => e.kind === 'stdout');
    expect(stdout.some((e) => e.text.includes('tail'))).toBe(true); // NOT dropped
    for (const e of stdout) expect(e.text).not.toContain('\u001b['); // flush path is sanitized too
  });

  it('routes a stderr line through progressParser into a progress event', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'err:frame=1 time=00:00:05.00 speed=1.0x'],
      cwd: here,
      sandboxPolicy: policy,
      progressParser: makeFfmpegProgressParser(10),
    };
    const events = await collect(spec, new AbortController().signal);
    const prog = events.find((e) => e.kind === 'progress') as Extract<
      RunnerEvent,
      { kind: 'progress' }
    >;
    expect(prog).toBeDefined();
    expect(prog.progress).toBeCloseTo(0.5, 2);
    // the matched line is emitted ONLY as progress, never also as a raw stderr line
    expect(events.some((e) => e.kind === 'stderr' && e.text.includes('time='))).toBe(false);
  });

  it('kills the whole process group on abort, SIGTERM then SIGKILL, a grandchild that ignores SIGTERM included', async () => {
    const ctl = new AbortController();
    // The grandchild holds stdout open for 30 s and ignores SIGTERM: killing only the direct child leaves
    // the pipe open, no close arrives and the row times out.
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'out:starting', 'hang', 'grandchild'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({ sandbox: fakeSandbox(), checkHardFloor: passHardFloor }).run(
      spec,
      ctl.signal,
    );
    const events: RunnerEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.kind === 'stdout') ctl.abort();
    }
    const exit = events.at(-1) as Extract<RunnerEvent, { kind: 'exit' }>;
    expect(exit.kind).toBe('exit');
    expect(exit.signal).toBe('SIGKILL');
  }, 15000);

  it('fail-closed: a wrapArgv rejection aborts the run BEFORE any spawn', async () => {
    // A real capturing fake spawn (counter) typed as the narrowed SpawnFn — no vi spy (the real-fake testing rule).
    let spawnCalls = 0;
    const spawnSpy = ((): never => {
      spawnCalls++;
      throw new Error('unexpected spawn');
    }) as SpawnFn;
    const sandbox = fakeSandbox({
      wrapArgv: async () => {
        throw new SandboxUnavailableError('unsupported platform — fail closed');
      },
    });
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({ sandbox, checkHardFloor: passHardFloor, spawn: spawnSpy }).run(
      spec,
      new AbortController().signal,
    );
    await expect(gen.next()).rejects.toThrow(/fail closed/);
    expect(spawnCalls).toBe(0); // no unsandboxed spawn, ever
  });

  it('exec-time re-gate: a hard-floor-blocked resolved argv[0] aborts BEFORE any spawn', async () => {
    let spawnCalls = 0;
    const spawnSpy = ((): never => {
      spawnCalls++;
      throw new Error('unexpected spawn');
    }) as SpawnFn;
    // The runner re-resolves spec.command and re-runs this; a blocked verdict must throw pre-spawn.
    const blockFloor = (): { blocked: boolean; reason?: string } => ({
      blocked: true,
      reason: 'egress binary (resolved)',
    });
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: blockFloor,
      spawn: spawnSpy,
    }).run(spec, new AbortController().signal);
    await expect(gen.next()).rejects.toThrow(/egress binary/);
    expect(spawnCalls).toBe(0); // re-gate fail-closed — nothing spawned, nothing wrapped
  });

  it('maps a spawn error (ENOENT) to a structured nonzero exit — never an escaped throw', async () => {
    // wrapArgv returns a nonexistent argv[0], so the REAL node spawn emits an 'error' event (ENOENT).
    // The runner's error handler must surface it as a nonzero exit, not let the error escape.
    const sandbox = fakeSandbox({
      wrapArgv: async () => ({ argv: ['/no/such/minitui/bin/nope'], env: { ...process.env } }),
    });
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events: RunnerEvent[] = [];
    const runner = createLocalRunner({ sandbox, checkHardFloor: passHardFloor });
    for await (const ev of runner.run(spec, new AbortController().signal)) events.push(ev);
    const exit = events.at(-1) as Extract<RunnerEvent, { kind: 'exit' }>;
    expect(exit.kind).toBe('exit');
    expect(exit.code).not.toBe(0); // ENOENT surfaced as a failed exit (127), not thrown
  });

  it('attaches the child error listener BEFORE yielding started — an async gap after started cannot crash the host', async () => {
    // A REAL fake child (injected through the spawn seam — zero replacement-mocks) that emits an
    // ENOENT-shaped 'error' one macrotask AFTER run() returns `started`. With listeners wired
    // post-yield (the OLD order) this error fires in the consumer's await gap with NO listener →
    // Node throws unhandled 'error' and crashes the host; wired pre-yield it becomes exit 127.
    const spawnFake = (() => {
      // a failed spawn has already exited (node reports the negative errno), so the orphan guard has nothing to signal
      const child = new FakeChild(4242, -2);
      setTimeout(
        () => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
        0,
      );
      return child;
    }) as SpawnFn;
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: passHardFloor,
      spawn: spawnFake,
    }).run(spec, new AbortController().signal);
    const first = await gen.next();
    expect((first.value as RunnerEvent).kind).toBe('started');
    await new Promise((r) => setTimeout(r, 5)); // the 'error' fires HERE, in the gap between pulls
    const rest: RunnerEvent[] = [];
    for await (const ev of gen) rest.push(ev);
    const exit = rest.at(-1) as Extract<RunnerEvent, { kind: 'exit' }>;
    expect(exit.kind).toBe('exit');
    expect(exit.code).toBe(127); // ENOENT captured pre-yield, surfaced as exit — no unhandled throw
  });

  it('warns through diagnostics when the child exits 159 (128+SIGSYS — the wrapped seccomp-kill form)', async () => {
    // A REAL fake child (injected through the spawn seam) that closes with exit 159 / signal null —
    // the only Linux-observable form of a workload SIGSYS under the [sh -c bwrap] wrap. The runner's
    // close-handler must warn through the injected diagnostics sink and still surface exit 159.
    const warnings: string[] = [];
    const diagnostics: DiagnosticsPort = {
      warn: (msg) => {
        warnings.push(msg);
      },
      debug: () => {},
    };
    const spawnFake = (() => {
      const child = new FakeChild(4243, 159);
      setTimeout(() => child.emit('close', 159, null), 0);
      return child;
    }) as SpawnFn;
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events: RunnerEvent[] = [];
    for await (const ev of createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: passHardFloor,
      spawn: spawnFake,
      diagnostics,
    }).run(spec, new AbortController().signal)) {
      events.push(ev);
    }
    const exit = events.at(-1) as Extract<RunnerEvent, { kind: 'exit' }>;
    expect(exit.code).toBe(159);
    expect(warnings.some((w) => w.toLowerCase().includes('sandbox'))).toBe(true);
  });

  it('spawns with the environment the wrap returned, scrubbed, never the host one', async () => {
    const sandbox = fakeSandbox({
      wrapArgv: async (command: string) => ({
        argv: ['/bin/sh', '-c', `exec ${command}`],
        env: { PATH: process.env.PATH, TZ: 'Wrapped/Zone', LD_PRELOAD: '/evil.so' },
      }),
    });
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'env:TZ', 'env:LD_PRELOAD'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events: RunnerEvent[] = [];
    for await (const ev of createLocalRunner({ sandbox, checkHardFloor: passHardFloor }).run(
      spec,
      new AbortController().signal,
    )) {
      events.push(ev);
    }
    const out = events.flatMap((e) => (e.kind === 'stdout' ? [e.text] : []));
    expect(out).toContain('TZ=Wrapped/Zone'); // the wrap's value, not the host's
    expect(out).toContain('LD_PRELOAD='); // scrubbed
  });

  it('re-gates the resolved executable: a harmless-named link to a file named curl is refused before any spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minitui-regate-'));
    try {
      const real = join(dir, 'curl');
      writeFileSync(real, '', { mode: 0o755 });
      const link = join(dir, 'harmless');
      symlinkSync(real, link);
      let spawnCalls = 0;
      const spawnSpy = ((): never => {
        spawnCalls++;
        throw new Error('unexpected spawn');
      }) as SpawnFn;
      const spec: RunSpec = { command: link, args: [], cwd: here, sandboxPolicy: policy };
      const gen = createLocalRunner({
        sandbox: fakeSandbox(),
        checkHardFloor,
        spawn: spawnSpy,
      }).run(spec, new AbortController().signal);
      await expect(gen.next()).rejects.toThrow(/network egress via curl/);
      expect(spawnCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits on a lone carriage return: two stats lines give two progress events, and the error line after them reaches stderr', async () => {
    // ffmpeg ends its interim stats lines with a carriage return; a split on line feeds alone would read
    // the three writes below as one line, report one progress event and lose the error text.
    const spec: RunSpec = {
      command: process.execPath,
      args: [
        EMIT,
        'cr:frame=1 time=00:00:02.00 speed=1.0x',
        'cr:frame=2 time=00:00:04.00 speed=1.0x',
        'err:Error opening output file',
      ],
      cwd: here,
      sandboxPolicy: policy,
      progressParser: makeFfmpegProgressParser(10),
    };
    const events = await collect(spec, new AbortController().signal);
    const progress = events.flatMap((e) => (e.kind === 'progress' ? [e.progress] : []));
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBeCloseTo(0.2, 2);
    expect(progress[1]).toBeCloseTo(0.4, 2);
    expect(events.findLastIndex((e) => e.kind === 'progress')).toBeLessThan(
      events.findIndex((e) => e.kind === 'exit'),
    );
    expect(events.some((e) => e.kind === 'stderr' && e.text === 'Error opening output file')).toBe(
      true,
    );
  });

  it('cuts a stream that never breaks a line into bounded lines and loses nothing', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'long:200000'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const events = await collect(spec, new AbortController().signal);
    const chunks = events.flatMap((e) => (e.kind === 'stdout' ? [e.text] : []));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThan(200_000);
    expect(chunks.join('')).toBe('a'.repeat(200_000));
  });

  it('decodes a multibyte character cut between two reads, one decoder per channel, and keeps a lone lead byte left at close', async () => {
    const child = new StreamChild(4244, 0);
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: passHardFloor,
      spawn: (() => child) as SpawnFn,
    }).run(spec, new AbortController().signal);
    expect(((await gen.next()).value as RunnerEvent).kind).toBe('started');
    // Both characters start with the byte 0xC3. Their halves arrive interleaved across the two channels: one
    // decoder shared by the channels would join a stdout half with a stderr half and garble both.
    const stdoutChar = Buffer.from('é'); // 0xC3 0xA9
    const stderrChar = Buffer.from('ü'); // 0xC3 0xBC
    child.stdout.emit('data', stdoutChar.subarray(0, 1));
    child.stderr.emit('data', stderrChar.subarray(0, 1));
    child.stdout.emit('data', Buffer.concat([stdoutChar.subarray(1), Buffer.from('\n')]));
    child.stderr.emit('data', Buffer.concat([stderrChar.subarray(1), Buffer.from('\n')]));
    // the stream ends on a line break followed by a lone lead byte: the flush must not drop it
    child.stdout.emit('data', Buffer.from([0xc3]));
    child.emit('close', 0, null);
    const events = await drain(gen);
    const lines = (kind: 'stdout' | 'stderr'): string[] =>
      events.flatMap((e) => (e.kind === kind ? [e.text] : []));
    const replacement = String.fromCharCode(0xfffd); // what a decoder writes for a cut character that never completes
    expect(lines('stdout')).toEqual(['é', replacement]);
    expect(lines('stderr')).toEqual(['ü']);
    expect(events.at(-1)).toEqual({ kind: 'exit', code: 0, signal: null });
  });

  it('kills the group and removes the abort listener when the consumer abandons the run right after started', async () => {
    // A real spawn, recorded through the production seam, so the row can watch the child it started.
    const spawned: ChildProcess[] = [];
    const recordingSpawn: SpawnFn = (command, args, options) => {
      const child = nodeSpawn(command, args, options);
      spawned.push(child);
      return child;
    };
    const ctl = new AbortController();
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'hang'],
      cwd: here,
      sandboxPolicy: policy,
    };
    const gen = createLocalRunner({
      sandbox: fakeSandbox(),
      checkHardFloor: passHardFloor,
      spawn: recordingSpawn,
    }).run(spec, ctl.signal);
    const first = await gen.next();
    expect((first.value as RunnerEvent).kind).toBe('started');
    const [child] = spawned;
    if (child === undefined) throw new Error('the runner spawned nothing');
    // bounded below the row timeout, so a runner that leaves the child alive fails on the assertion
    const exited = new Promise<NodeJS.Signals | null | 'still running'>((resolve) => {
      const timer = setTimeout(() => resolve('still running'), 5000);
      child.once('exit', (_code, signal) => {
        clearTimeout(timer);
        resolve(signal);
      });
    });
    try {
      await gen.return(undefined);
      expect(await exited).toBe('SIGKILL');
      expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // the group is already gone
        }
      }
    }
  }, 15000);

  it('reports each resolved wrap finished exactly once after a run, an abort, a spawn error and an abandoned run', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT, 'out:x'],
      cwd: here,
      sandboxPolicy: policy,
    };

    // a run that settles: outstanding while it runs, reported finished at the end
    const settled = countingSandbox(shellWrap);
    let atStarted = { wraps: -1, cleanups: -1 };
    for await (const ev of createLocalRunner({
      sandbox: settled.sandbox,
      checkHardFloor: passHardFloor,
    }).run(spec, new AbortController().signal)) {
      if (ev.kind === 'started') atStarted = settled.counts();
    }
    expect(atStarted).toEqual({ wraps: 1, cleanups: 0 });
    expect(settled.counts()).toEqual({ wraps: 1, cleanups: 1 });

    // an abort of a program that dies on SIGTERM
    const aborted = countingSandbox(async () => SLEEPER);
    const ctl = new AbortController();
    const abortEvents: RunnerEvent[] = [];
    for await (const ev of createLocalRunner({
      sandbox: aborted.sandbox,
      checkHardFloor: passHardFloor,
    }).run(spec, ctl.signal)) {
      abortEvents.push(ev);
      if (ev.kind === 'started') ctl.abort();
    }
    expect(abortEvents.at(-1)).toEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });
    expect(aborted.counts()).toEqual({ wraps: 1, cleanups: 1 });

    // a spawn error, surfaced as an exit
    const missing = countingSandbox(async () => ({
      argv: ['/no/such/minitui/bin/nope'],
      env: { ...process.env },
    }));
    const missingEvents = await drain(
      createLocalRunner({ sandbox: missing.sandbox, checkHardFloor: passHardFloor }).run(
        spec,
        new AbortController().signal,
      ),
    );
    expect(missingEvents.at(-1)).toEqual({ kind: 'exit', code: 127, signal: null });
    expect(missing.counts()).toEqual({ wraps: 1, cleanups: 1 });

    // a run the consumer abandons right after started
    const abandoned = countingSandbox(async () => SLEEPER);
    const gen = createLocalRunner({
      sandbox: abandoned.sandbox,
      checkHardFloor: passHardFloor,
    }).run(spec, new AbortController().signal);
    await gen.next();
    await gen.return(undefined);
    expect(abandoned.counts()).toEqual({ wraps: 1, cleanups: 1 });
  });

  it('reports a resolved wrap finished when the run is refused after it (bad cwd, empty argv), never after a rejected wrap', async () => {
    const spec: RunSpec = {
      command: process.execPath,
      args: [EMIT],
      cwd: here,
      sandboxPolicy: policy,
    };

    const badCwd = countingSandbox(shellWrap);
    const cwdRun = createLocalRunner({
      sandbox: badCwd.sandbox,
      checkHardFloor: passHardFloor,
    }).run({ ...spec, cwd: '/no/such/minitui/dir/xyz' }, new AbortController().signal);
    await expect(cwdRun.next()).rejects.toThrow(/does not exist/);
    expect(badCwd.counts()).toEqual({ wraps: 1, cleanups: 1 });

    const empty = countingSandbox(async () => ({ argv: [], env: { ...process.env } }));
    const emptyRun = createLocalRunner({
      sandbox: empty.sandbox,
      checkHardFloor: passHardFloor,
    }).run(spec, new AbortController().signal);
    await expect(emptyRun.next()).rejects.toThrow(/empty argv/);
    expect(empty.counts()).toEqual({ wraps: 1, cleanups: 1 });

    const rejected = countingSandbox(async () => {
      throw new SandboxUnavailableError('wrap refused');
    });
    const rejectedRun = createLocalRunner({
      sandbox: rejected.sandbox,
      checkHardFloor: passHardFloor,
    }).run(spec, new AbortController().signal);
    await expect(rejectedRun.next()).rejects.toThrow(/wrap refused/);
    expect(rejected.counts()).toEqual({ wraps: 0, cleanups: 0 });
  });

  it('a run whose signal is already aborted reports an exit before the re-gate, the wrap and the spawn', async () => {
    let floorCalls = 0;
    let wrapCalls = 0;
    let spawnCalls = 0;
    const ctl = new AbortController();
    ctl.abort();
    const runner = createLocalRunner({
      sandbox: fakeSandbox({
        wrapArgv: async (command: string) => {
          wrapCalls++;
          return shellWrap(command);
        },
      }),
      checkHardFloor: () => {
        floorCalls++;
        return { blocked: false };
      },
      spawn: ((): never => {
        spawnCalls++;
        throw new Error('unexpected spawn');
      }) as SpawnFn,
    });
    const events = await drain(
      runner.run(
        { command: process.execPath, args: [EMIT], cwd: here, sandboxPolicy: policy },
        ctl.signal,
      ),
    );
    expect(events).toEqual([{ kind: 'exit', code: null, signal: 'SIGTERM' }]);
    expect({ floorCalls, wrapCalls, spawnCalls }).toEqual({
      floorCalls: 0,
      wrapCalls: 0,
      spawnCalls: 0,
    });
  });

  it('an abort that lands while the wrap is pending kills the child as soon as it is spawned', async () => {
    // The program exits by itself after 3 s, so a runner that misses the abort reports a clean exit.
    const ctl = new AbortController();
    const sandbox = fakeSandbox({
      wrapArgv: async () => {
        ctl.abort();
        return {
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 3000)'],
          env: { ...process.env },
        };
      },
    });
    const events = await drain(
      createLocalRunner({ sandbox, checkHardFloor: passHardFloor }).run(
        { command: process.execPath, args: [EMIT], cwd: here, sandboxPolicy: policy },
        ctl.signal,
      ),
    );
    expect(events[0]?.kind).toBe('started');
    expect(events.at(-1)).toEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });
  });
});

describe('quoteCommand', () => {
  it('single-quote-wraps a token containing spaces', () => {
    expect(quoteCommand('/usr/bin/ffmpeg', ['a b', 'c'])).toBe(`'/usr/bin/ffmpeg' 'a b' 'c'`);
  });

  it('POSIX-escapes an embedded single quote', () => {
    // "it's" -> close-quote + escaped-quote + reopen-quote inside the wrap: 'it'\''s'
    expect(quoteCommand('/bin/echo', ["it's"])).toBe(`'/bin/echo' 'it'\\''s'`);
  });
});
