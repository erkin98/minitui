import { describe, it, expect } from 'vitest';
import {
  routeObservation,
  routeToolCallResult,
  routeRuntimeFault,
  summarizeExecEvents,
  type ObservationInput,
} from '../src/visibility/observation-router.js';
import type { ToolCallResult } from '../src/ports/tool-dispatch-port.js';
import type { ExecEvent, RuntimeFault } from '@minitui/types';
import type { MinituiEvent } from '../src/events/index.js';

const policy = { homeDir: '/home/alice', tmpDir: '/tmp' };

// MinituiEvent is a discriminated union; both routers return the union-typed observation. This
// narrows to the TOOL_CALL_RESULT member so the field assertions type-check, and throws if the
// router ever built the wrong variant (so the narrowing is a real assertion, not a blind cast).
function asToolResult(
  ev: MinituiEvent,
): asserts ev is Extract<MinituiEvent, { type: 'TOOL_CALL_RESULT' }> {
  if (ev.type !== 'TOOL_CALL_RESULT') throw new Error(`expected TOOL_CALL_RESULT, got ${ev.type}`);
}

describe('routeObservation', () => {
  it('maps a successful result to a non-error AGENT_OBSERVATION carrying toolName', () => {
    const input: ObservationInput = {
      toolCallId: 'tc-1',
      result: { actionName: 'merge', ok: true, value: 'wrote /home/alice/out.mp4' },
      exitCode: 0,
    };
    const ev = routeObservation(input, policy);
    asToolResult(ev);
    expect(ev.type).toBe('TOOL_CALL_RESULT');
    expect(ev.toolCallId).toBe('tc-1');
    expect(ev.toolName).toBe('merge'); // sourced from result.actionName
    expect(ev.isError).toBe(false);
    expect(ev.error).toBeUndefined();
    expect(ev.content).toContain('~/out.mp4'); // path redacted
    expect(ev.content).not.toContain('/home/alice');
  });

  it('maps a failed result to an error AGENT_OBSERVATION with redacted failure in the error slot', () => {
    const input: ObservationInput = {
      toolCallId: 'tc-2',
      result: { actionName: 'merge', ok: false, error: 'codec mismatch' },
      stderrExcerpt:
        'ffmpeg: cannot read /home/alice/.ssh/id_rsa key sk-abc123DEF456ghi789JKL012mno',
      exitCode: 1,
    };
    const ev = routeObservation(input, policy);
    asToolResult(ev);
    expect(ev.isError).toBe(true);
    expect(ev.content).toBe(''); // no normal output on this failure
    expect(ev.error).toContain('codec mismatch');
    expect(ev.error).toContain('~/.ssh/id_rsa');
    expect(ev.error).toContain('[redacted-secret]');
    expect(ev.error).toContain('exit 1');
    expect(ev.error).not.toContain('sk-abc123DEF456ghi789JKL012mno');
  });

  it('forces isError true on a non-zero exit even if result.ok is true', () => {
    const input: ObservationInput = {
      toolCallId: 'tc-3',
      result: { actionName: 'merge', ok: true },
      exitCode: 137,
    };
    const ev = routeObservation(input, policy);
    asToolResult(ev);
    expect(ev.isError).toBe(true);
    expect(ev.error).toContain('exit 137');
  });
});

describe('routeToolCallResult', () => {
  it('redacts content and threads toolCallId + toolName through', () => {
    const result: ToolCallResult = {
      toolCallId: 'tc-4',
      toolName: 'probe',
      ok: true,
      content: 'probed /home/alice/in.mp4 with key sk-abc123DEF456ghi789JKL012mno',
      isError: false,
    };
    const ev = routeToolCallResult(result, policy);
    asToolResult(ev);
    expect(ev.type).toBe('TOOL_CALL_RESULT');
    expect(ev.toolCallId).toBe('tc-4');
    expect(ev.toolName).toBe('probe');
    expect(ev.isError).toBe(false);
    expect(ev.content).toContain('~/in.mp4');
    expect(ev.content).toContain('[redacted-secret]');
    expect(ev.content).not.toContain('sk-abc123DEF456ghi789JKL012mno');
  });

  it('maps ok:false to isError with the redacted error slot', () => {
    const result: ToolCallResult = {
      toolCallId: 'tc-5',
      toolName: 'merge',
      ok: false,
      content: '',
      isError: true,
      error: 'cannot open /home/alice/clip.mp4',
    };
    const ev = routeToolCallResult(result, policy);
    asToolResult(ev);
    expect(ev.isError).toBe(true);
    expect(ev.error).toBe('cannot open ~/clip.mp4');
  });

  it('preserves `denied` as a distinct field so the model can tell refusal from failure', () => {
    const result: ToolCallResult = {
      toolCallId: 'tc-6',
      toolName: 'merge',
      ok: false,
      content: '',
      isError: false,
      denied: true,
    };
    const ev = routeToolCallResult(result, policy);
    asToolResult(ev);
    expect(ev.isError).toBe(true);
    expect(ev.denied).toBe(true); // the boolean survives — NOT flattened into error text
    expect(ev.error).toBe('execution denied'); // the wording is a supplementary hint alongside the flag
  });
});

describe('summarizeExecEvents', () => {
  it('folds a finished stream into ok + exitCode + stderr excerpt', () => {
    const events: ExecEvent[] = [
      { kind: 'stdout', chunk: 'frame 1\n' },
      { kind: 'stderr', chunk: 'warning: deprecated\n' },
      { kind: 'exit', code: 0 },
    ];
    expect(summarizeExecEvents(events)).toEqual({
      ok: true,
      exitCode: 0,
      stderrExcerpt: 'warning: deprecated\n',
    });
  });

  it('reports ok:false on a non-zero exit', () => {
    const events: ExecEvent[] = [
      { kind: 'stderr', chunk: 'boom\n' },
      { kind: 'exit', code: 2 },
    ];
    const s = summarizeExecEvents(events);
    expect(s.ok).toBe(false);
    expect(s.exitCode).toBe(2);
  });

  it('caps the stderr excerpt length', () => {
    const big = 'x'.repeat(10_000);
    const s = summarizeExecEvents([
      { kind: 'stderr', chunk: big },
      { kind: 'exit', code: 1 },
    ]);
    expect(s.stderrExcerpt!.length).toBeLessThanOrEqual(4096);
  });
});

describe('routeRuntimeFault (post-mount error round-trip bridge)', () => {
  it('redacts the fault, calls the injected spec builder, and re-enters the session via submit', async () => {
    const fault: RuntimeFault = {
      actionKey: 'merge',
      exitCode: 1,
      stderrExcerpt:
        'ffmpeg: cannot read /home/alice/.ssh/id_rsa key sk-abc123DEF456ghi789JKL012mno',
    };
    // The spec-owned builder (injected). It must receive an ALREADY-REDACTED fault; agent-core never
    // authors the wording. Returns the reprompt the session re-enters on.
    let builderSaw: RuntimeFault | undefined;
    const buildRepair = (f: RuntimeFault): string => {
      builderSaw = f;
      return `action ${f.actionKey} failed (exit ${f.exitCode}): ${f.stderrExcerpt}. Regenerate a corrected spec.`;
    };
    // A minimal RepairIngress stub (AgentSession satisfies this shape structurally).
    let submittedReprompt: string | undefined;
    const session = {
      async *submit(reprompt: string): AsyncGenerator<MinituiEvent> {
        submittedReprompt = reprompt;
        yield { type: 'RUN_STARTED', threadId: 'th', runId: 'r2' } as MinituiEvent;
        yield { type: 'RUN_FINISHED', threadId: 'th', runId: 'r2' } as MinituiEvent;
      },
    };
    const out: MinituiEvent[] = [];
    for await (const e of routeRuntimeFault(fault, session, buildRepair, policy)) out.push(e);
    // the builder saw a REDACTED fault — no raw home path / secret reached spec's wording
    expect(builderSaw?.stderrExcerpt).toBe(
      'ffmpeg: cannot read ~/.ssh/id_rsa key [redacted-secret]',
    );
    expect(builderSaw?.stderrExcerpt).not.toContain('/home/alice');
    expect(builderSaw?.stderrExcerpt).not.toContain('sk-abc123DEF456ghi789JKL012mno');
    // the redacted reprompt was submitted into the live session, and its events flowed back out
    expect(submittedReprompt).toContain('~/.ssh/id_rsa');
    expect(out.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });
});

describe('a cyclic value', () => {
  it('routeObservation does not throw or loop on a cyclic result value', () => {
    const cyclic: Record<string, unknown> = { path: '/home/alice/x' };
    cyclic.self = cyclic;
    const ev = routeObservation(
      { toolCallId: 'tc-c', result: { actionName: 'probe', ok: true, value: cyclic } },
      policy,
    );
    asToolResult(ev);
    expect(ev.isError).toBe(false);
    expect(typeof ev.content).toBe('string');
  });
});

describe('a fault text is windowed, redacted, then cut', () => {
  const key = `sk-proj-${'Ab1_'.repeat(21)}Ab1`; // 95 generated characters
  const KEY_TAIL = key.slice(-10);

  it('summarizeExecEvents keeps the end of stderr, not the start', () => {
    const stderr = `start-marker ${'x'.repeat(20_000)} end-marker`;
    const s = summarizeExecEvents([
      { kind: 'stderr', chunk: stderr },
      { kind: 'exit', code: 1 },
    ]);
    expect(s.stderrExcerpt!.length).toBeLessThanOrEqual(4096);
    expect(s.stderrExcerpt!.endsWith('end-marker')).toBe(true);
    expect(s.stderrExcerpt).not.toContain('start-marker');
  });

  it('a key that a cap-first cut would split leaves no fragment in the excerpt', () => {
    // 15 characters of the key sit before the 4096-character cut of the raw text
    const stderr = `${'p'.repeat(100)} ${key} ${'q'.repeat(4015)}`;
    const s = summarizeExecEvents(
      [
        { kind: 'stderr', chunk: stderr },
        { kind: 'exit', code: 1 },
      ],
      policy,
    );
    expect(s.stderrExcerpt!.length).toBeLessThanOrEqual(4096);
    expect(s.stderrExcerpt).not.toContain(KEY_TAIL);
    expect(s.stderrExcerpt).not.toContain('sk-proj-');
  });

  const FAULT = `${'p'.repeat(16_384 - 4081 - key.length - 1)} ${key} ${'q'.repeat(4080)}`;

  it('routeRuntimeFault hands the builder at most 4096 characters, with no fragment of the key', async () => {
    expect(FAULT).toHaveLength(16_384);
    let seen: RuntimeFault | undefined;
    const session = {
      async *submit(): AsyncGenerator<MinituiEvent> {
        yield { type: 'RUN_FINISHED', threadId: 't', runId: 'r' } as MinituiEvent;
      },
    };
    const fault: RuntimeFault = { actionKey: 'merge', exitCode: 1, stderrExcerpt: FAULT };
    for await (const _ of routeRuntimeFault(fault, session, (f) => ((seen = f), 'again'), policy)) {
      /* drain */
    }
    expect(seen!.stderrExcerpt.length).toBeLessThanOrEqual(4096);
    expect(seen!.stderrExcerpt.endsWith('q')).toBe(true);
    expect(seen!.stderrExcerpt).not.toContain(KEY_TAIL);
  });

  it('routeToolCallResult cuts the error text the same way', () => {
    const result: ToolCallResult = {
      toolCallId: 'tc-t',
      toolName: 'merge',
      ok: false,
      content: '',
      isError: true,
      error: FAULT,
    };
    const ev = routeToolCallResult(result, policy);
    asToolResult(ev);
    expect(ev.error!.length).toBeLessThanOrEqual(4096);
    expect(ev.error!.endsWith('q')).toBe(true);
    expect(ev.error).not.toContain(KEY_TAIL);
  });
});
