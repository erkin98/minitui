import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { SandboxManagerHandle } from '../../src/sandbox/index.js';

// A REAL-shaped fake handle (the sandbox surface) — pass-through wrap, no `as never`. The shell double
// execs the program, so the direct child is the program on every /bin/sh (dash forks otherwise).
export function fakeSandbox(overrides?: Partial<SandboxManagerHandle>): SandboxManagerHandle {
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
export const passHardFloor = (): { blocked: boolean; reason?: string } => ({ blocked: false });

// A real child-process object that never spawns anything. It holds what the runner reads (pid, the two
// output streams, the exit state, kill), so the spawn doubles below need no cast to ChildProcess. The exit
// code is given and never null: the runner's orphan guard signals the group of a child that has not exited.
export class FakeChild extends ChildProcess {
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
export class StreamChild extends ChildProcess {
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
