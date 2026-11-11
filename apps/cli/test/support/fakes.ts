import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MinituiEvent } from '@minitui/agent-core';
import { SandboxUnavailableError, type SandboxManagerHandle } from '@minitui/exec';
import type { CapabilityProvider } from '@minitui/spec';
import type { DiagnosticsPort } from '@minitui/types';
import type { SessionLike } from '../../src/graph-types.js';

export interface DiagnosticsRecord {
  readonly level: 'warn' | 'debug';
  readonly msg: string;
  readonly meta: Record<string, unknown> | undefined;
}

/** A real capturing DiagnosticsPort. */
export function recordingDiagnostics(): {
  records: DiagnosticsRecord[];
  diagnostics: DiagnosticsPort;
} {
  const records: DiagnosticsRecord[] = [];
  return {
    records,
    diagnostics: {
      warn: (msg, meta) => {
        records.push({ level: 'warn', msg, meta });
      },
      debug: (msg, meta) => {
        records.push({ level: 'debug', msg, meta });
      },
    },
  };
}

/**
 * A real implementation of the sandbox handle: active or not, it refuses what the real one refuses (an
 * inactive handle throws on a gated kind) and counts its disposals. Nothing here runs a process.
 */
export function fakeSandbox(
  active: boolean,
  errors: readonly string[] = [],
): { handle: SandboxManagerHandle; wraps: () => number; disposals: () => number } {
  let wraps = 0;
  let disposals = 0;
  const refuse = (what: string): never => {
    throw new SandboxUnavailableError(`sandbox unavailable: refusing ${what}`);
  };
  const handle: SandboxManagerHandle = {
    probe: { supported: active, errors, warnings: [], platform: 'linux' },
    active,
    wrapCommand: () => {
      wraps += 1;
      return Promise.reject(new SandboxUnavailableError('sandbox unavailable'));
    },
    wrapArgv: () => {
      wraps += 1;
      return Promise.reject(new SandboxUnavailableError('sandbox unavailable'));
    },
    violationsFor: () => Promise.resolve([]),
    assertGatable: (kind) => {
      if (!active && kind !== 'render-local') refuse('a gated action');
    },
    cleanup: () => {},
    dispose: () => {
      disposals += 1;
      return Promise.resolve();
    },
  };
  return { handle, wraps: () => wraps, disposals: () => disposals };
}

/** A capability provider that knows every file and a few encoders, so a valid spec passes the gate. */
export const capableHost: CapabilityProvider = {
  listEncoders: () => Promise.resolve(['libx264', 'h264']),
  listCodecs: () => Promise.resolve(['h264']),
  listFilters: () => Promise.resolve([]),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

/** An output whose directory exists, since the router resolves it before it asks for consent. */
export const OUTPUT = join(tmpdir(), 'minitui-cli-test-out.mp4');

/** The patch lines of a merge app that passes the real validation loop against `capableHost`. */
export const VALID_SPEC_LINES = [
  { op: 'add', path: '/root', value: 'go' },
  {
    op: 'add',
    path: '/elements/go',
    value: {
      type: 'Button',
      props: { label: 'Merge' },
      on: {
        press: {
          action: 'merge',
          params: {
            inputs: { $state: '/inputs' },
            codec: { $state: '/codec' },
            output: { $state: '/output' },
          },
        },
      },
    },
  },
  {
    op: 'add',
    path: '/state',
    value: {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      codec: 'h264',
      output: OUTPUT,
      merge: { progress: 0, status: '' },
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join('\n')
  .concat('\n');

/** One turn of the session: a start event and the given text. */
export async function* textTurn(text: string): AsyncGenerator<MinituiEvent> {
  await Promise.resolve();
  yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
  yield { type: 'TEXT_MESSAGE_CONTENT', delta: text };
}

/** A real session slice: its turns come from `submit`, and every call is recorded. */
export function fakeSession(
  over: {
    submit?: (intent: string, opts?: { signal?: AbortSignal }) => AsyncGenerator<MinituiEvent>;
    onCancel?: () => void;
  } = {},
): SessionLike & { submits: Array<{ intent: string; signal: AbortSignal | undefined }> } {
  const submits: Array<{ intent: string; signal: AbortSignal | undefined }> = [];
  return {
    submits,
    threadId: 'thread-1',
    submit: (intent, opts) => {
      submits.push({ intent, signal: opts?.signal });
      return over.submit ? over.submit(intent, opts) : textTurn('');
    },
    cancel: () => {
      over.onCancel?.();
    },
    emitSpec: (spec) => ({ type: 'ACTIVITY_SNAPSHOT', spec }),
  };
}

/** Polls `predicate` on the event loop; fails loudly, with what it waited for, when it never holds. */
export async function until(predicate: () => boolean, label: string, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}
