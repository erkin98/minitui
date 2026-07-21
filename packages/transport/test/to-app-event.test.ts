import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { toAppEvent } from '../src/events/to-app-event.js';

describe('toAppEvent (single normalization chokepoint)', () => {
  it('normalizes STATE_DELTA into a state-delta AppEvent', () => {
    const ev = toAppEvent({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'replace', path: '/p', value: 1 }],
    });
    expect(ev).toEqual({ kind: 'state-delta', delta: [{ op: 'replace', path: '/p', value: 1 }] });
  });

  it('normalizes STATE_SNAPSHOT', () => {
    const ev = toAppEvent({ type: EventType.STATE_SNAPSHOT, snapshot: { a: 1 } });
    expect(ev).toEqual({ kind: 'state-snapshot', snapshot: { a: 1 } });
  });

  it('marks a ContextOverflow RUN_ERROR as non-retriable', () => {
    const ev = toAppEvent({
      type: EventType.RUN_ERROR,
      message: 'context window exceeded',
      code: 'ContextOverflow',
    });
    expect(ev).toEqual({
      kind: 'run-error',
      message: 'context window exceeded',
      code: 'ContextOverflow',
      retriable: false,
    });
  });

  it('marks a RUN_ERROR with code non-retriable as non-retriable (plan-11 producer vocabulary, §Z79)', () => {
    // The one non-retriable code the local producer actually emits (plan-11 maps retriable:false to
    // code:'non-retriable'). It MUST decode to retriable:false — else the error that must never
    // re-feed (context-overflow rides this code) gets re-fed. Positive control for the §Z79 seam.
    const ev = toAppEvent({
      type: EventType.RUN_ERROR,
      message: 'context window exceeded',
      code: 'non-retriable',
    });
    expect(ev).toEqual({
      kind: 'run-error',
      message: 'context window exceeded',
      code: 'non-retriable',
      retriable: false,
    });
  });

  it('marks a generic RUN_ERROR as retriable', () => {
    const ev = toAppEvent({ type: EventType.RUN_ERROR, message: 'network blip' });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: true });
  });

  it('honors an explicit wire retriable flag (a Slice-2+ BFF extension, §Z79; Slice-1 uses code)', () => {
    const ev = toAppEvent({ type: EventType.RUN_ERROR, message: 'gate refused', retriable: false });
    expect(ev).toEqual({
      kind: 'run-error',
      message: 'gate refused',
      code: undefined,
      retriable: false,
    });
  });

  it('maps TOOL_CALL_RESULT carrying its toolCallId, toolName, and content', () => {
    const ev = toAppEvent({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: 't1',
      toolName: 'merge',
      content: 'ok',
    });
    expect(ev).toEqual({
      kind: 'tool-result',
      toolCallId: 't1',
      toolName: 'merge',
      content: 'ok',
      isError: false,
    });
  });

  it('passes the optional error slot through on a failed TOOL_CALL_RESULT (agent-core §N extension)', () => {
    const ev = toAppEvent({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: 't1',
      toolName: 'merge',
      content: '',
      isError: true,
      error: 'execution denied',
    });
    expect(ev).toEqual({
      kind: 'tool-result',
      toolCallId: 't1',
      toolName: 'merge',
      content: '',
      isError: true,
      error: 'execution denied',
    });
  });

  it('routes CUSTOM to a visibility note (default modelVisible)', () => {
    const ev = toAppEvent({ type: EventType.CUSTOM, name: 'note', value: 'picked 2 files' });
    expect(ev).toEqual({ kind: 'visibility', note: 'picked 2 files', visClass: 'modelVisible' });
  });

  it('routes RAW to visibility reading the REAL payload field `event` (never value/name) and honors a BFF-set visClass', () => {
    // real wire shape (repos/ag-ui core RawEventSchema): { type, event, source? };
    // visClass is a minitui/BFF extension no stock AG-UI producer sets.
    const ev = toAppEvent({
      type: EventType.RAW,
      event: 'internal',
      source: 'bff',
      visClass: 'modelOnly',
    });
    expect(ev).toEqual({ kind: 'visibility', note: 'internal', visClass: 'modelOnly' });
  });

  it('stringifies a non-string RAW event payload', () => {
    const ev = toAppEvent({ type: EventType.RAW, event: { probe: 1 } });
    expect(ev).toEqual({ kind: 'visibility', note: '{"probe":1}', visClass: 'modelVisible' });
  });

  it('falls back to modelVisible for an unknown visClass', () => {
    const ev = toAppEvent({ type: EventType.CUSTOM, value: 'x', visClass: 'bogus' });
    expect(ev).toMatchObject({ kind: 'visibility', visClass: 'modelVisible' });
  });

  it('maps ACTIVITY_SNAPSHOT to the ledger-pinned { spec } payload', () => {
    // minitui-owned shape (ledger G9 + plan-02 AgentEvent): payload = { spec }. The REAL AG-UI
    // ActivitySnapshotEvent carries { messageId, activityType, content } — mapping content→spec
    // belongs to the remote adapter if/when the remote BFF path ships. ONE shape here.
    const ev = toAppEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec: { root: 'r', elements: {} } });
    expect(ev).toEqual({ kind: 'activity-snapshot', spec: { root: 'r', elements: {} } });
  });

  it('carries the optional usage (token/cost totals) through on RUN_FINISHED (§Z57-A)', () => {
    const ev = toAppEvent({
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'r1',
      usage: { inputTokens: 42, outputTokens: 17 },
    });
    expect(ev).toEqual({
      kind: 'run-finished',
      threadId: 't1',
      runId: 'r1',
      usage: { inputTokens: 42, outputTokens: 17 },
    });
  });

  it('falls through to passthrough for an unconsumed kind', () => {
    const ev = toAppEvent({ type: EventType.STEP_STARTED });
    expect(ev).toEqual({ kind: 'passthrough', rawType: 'STEP_STARTED' });
  });

  it('fails closed on a reserved-key STATE_SNAPSHOT — rejects it as a non-retriable run-error (§Z100)', () => {
    // Positive control for the parse-not-cast wire guard: a hostile snapshot carrying an own
    // reserved key (`constructor`/`prototype`/`__proto__`) must never become a state-snapshot that
    // folds into the store. The canonical schema rejects it; toAppEvent is total, so it fails
    // closed to a run-error. STATE_DELTA mirrors this through JsonPatchArraySchema.
    const ev = toAppEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: JSON.parse('{"constructor":1}'),
    });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });
});
