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

  // ── PIN-RETRIABLE-FLOOR (C18) — the §Z79 non-retriable family is a hard, non-overridable floor.
  it('§Z79 floor: a non-retriable code overrides an explicit retriable:true wire flag', () => {
    // A Slice-2+ remote wire could set retriable:true on a ContextOverflow; the derived
    // non-retriable floor MUST win so a context-overflow error can never re-feed.
    const ev = toAppEvent({
      type: EventType.RUN_ERROR,
      message: 'x',
      code: 'ContextOverflow',
      retriable: true,
    });
    expect(ev).toEqual({
      kind: 'run-error',
      message: 'x',
      code: 'ContextOverflow',
      retriable: false,
    });
  });

  it('still honors an explicit retriable flag when the code is NOT in the non-retriable floor', () => {
    // Guards against over-fixing: the flag stays live for unknown/retriable codes.
    const ev = toAppEvent({
      type: EventType.RUN_ERROR,
      message: 'rate limited',
      code: 'RateLimited',
      retriable: false,
    });
    expect(ev).toEqual({
      kind: 'run-error',
      message: 'rate limited',
      code: 'RateLimited',
      retriable: false,
    });
  });

  // ── PIN-NORMALIZER-TOTAL (C08) — total + fail-closed; distinguish MISSING from malformed.
  it('fails closed on a STATE_SNAPSHOT with a MISSING snapshot (no fabricated null state)', () => {
    const ev = toAppEvent({ type: EventType.STATE_SNAPSHOT });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('fails closed on a STATE_DELTA with a MISSING delta (no fabricated empty patch)', () => {
    const ev = toAppEvent({ type: EventType.STATE_DELTA });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('fails closed on an object-valued type discriminant (never emits a non-string rawType)', () => {
    const ev = toAppEvent({ type: { malformed: true } });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('fails closed on an event object with an absent type', () => {
    const ev = toAppEvent({ notAType: 1 });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('fails closed on a reserved-key ACTIVITY_SNAPSHOT spec (parse-not-cast, §Z100)', () => {
    const ev = toAppEvent({
      type: EventType.ACTIVITY_SNAPSHOT,
      spec: JSON.parse('{"constructor":1}'),
    });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('clones the ACTIVITY_SNAPSHOT spec — a later wire mutation cannot reach the emitted event', () => {
    // The activity-snapshot local path must clone/validate, not alias: a caller mutating the
    // wire object after normalization must not be able to reach into the emitted AppEvent.
    const elements: Record<string, unknown> = {};
    const ev = toAppEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec: { root: 'r', elements } });
    elements.injected = true;
    expect(ev).toEqual({ kind: 'activity-snapshot', spec: { root: 'r', elements: {} } });
  });

  // ── Coverage: the STATE_DELTA fail-closed twin (its STATE_SNAPSHOT sibling was tested, it was not).
  it('fails closed on a reserved-key STATE_DELTA op value — non-retriable run-error (§Z100 mirror)', () => {
    // An op `value` bearing an own reserved key is rejected by JsonPatchArraySchema (its value
    // members route through the same §Z100 guard) before the delta can fold into the store.
    const ev = toAppEvent({
      type: EventType.STATE_DELTA,
      delta: [{ op: 'add', path: '/x', value: JSON.parse('{"constructor":1}') }],
    });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  // ── Coverage: the RUN_FINISHED fail-soft drop-invalid-usage branch (only the valid path was tested).
  it('drops invalid usage on RUN_FINISHED (fail-soft: still fires, no usage key, never throws)', () => {
    // An out-of-bounds usage count DROPS the usage field (never emits usage:undefined, never throws)
    // so a cosmetic token/cost counter can't abort a completed run.
    const ev = toAppEvent({
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'r1',
      usage: { inputTokens: -1, outputTokens: 5 },
    });
    // toStrictEqual so a fabricated `usage: undefined` (not just a real object) also fails.
    expect(ev).toStrictEqual({ kind: 'run-finished', threadId: 't1', runId: 'r1' });
  });
});
