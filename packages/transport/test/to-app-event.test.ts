import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { toAppEvent } from '../src/events/to-app-event.js';
import { CONSUMED_KINDS } from '../src/events/event-kinds.js';

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

  it('marks a RUN_ERROR with a non-retriable code as non-retriable', () => {
    // The one non-retriable code the local producer actually emits (retriable:false maps to
    // code:'non-retriable'). It MUST decode to retriable:false — else the error that must never
    // Context overflow uses this code so callers do not re-feed a terminal failure.
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

  it('honors an explicit wire retriable flag', () => {
    const ev = toAppEvent({ type: EventType.RUN_ERROR, message: 'gate refused', retriable: false });
    // toStrictEqual, not toEqual: the assertion is that `code` is an OWN key holding undefined.
    // toEqual treats an undefined-valued property as absent, so it passes whether or not the
    // key is emitted at all — which is exactly the distinction exactOptionalPropertyTypes draws.
    expect(ev).toStrictEqual({
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
      isError: false,
    });
    expect(ev).toEqual({
      kind: 'tool-result',
      toolCallId: 't1',
      toolName: 'merge',
      content: 'ok',
      isError: false,
    });
  });

  it('rejects TOOL_CALL_RESULT when toolName or isError is missing', () => {
    const base = {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: 't1',
      content: 'ok',
    };
    expect(toAppEvent({ ...base, isError: false })).toMatchObject({
      kind: 'run-error',
      retriable: false,
    });
    expect(toAppEvent({ ...base, toolName: 'merge' })).toMatchObject({
      kind: 'run-error',
      retriable: false,
    });
  });

  it('passes the optional error slot through on a failed TOOL_CALL_RESULT', () => {
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

  it('preserves TOOL_CALL_RESULT denial provenance', () => {
    const ev = toAppEvent({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: 't1',
      toolName: 'merge',
      content: '',
      isError: true,
      denied: true,
    });
    expect(ev).toMatchObject({ kind: 'tool-result', isError: true, denied: true });
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
    const ev = toAppEvent({ type: EventType.CUSTOM, name: 'note', value: 'x', visClass: 'bogus' });
    expect(ev).toMatchObject({ kind: 'visibility', visClass: 'modelVisible' });
  });

  it('distinguishes an own null CUSTOM value from a missing value', () => {
    expect(toAppEvent({ type: EventType.CUSTOM, name: 'note', value: null })).toEqual({
      kind: 'visibility',
      note: 'null',
      visClass: 'modelVisible',
    });
    expect(toAppEvent({ type: EventType.CUSTOM, name: 'note' })).toMatchObject({
      kind: 'run-error',
      retriable: false,
    });
  });

  it('maps ACTIVITY_SNAPSHOT to the canonical { spec } payload', () => {
    // The minitui-owned shape is payload = { spec }. The real AG-UI
    // ActivitySnapshotEvent carries { messageId, activityType, content } — mapping content→spec
    // belongs to the remote adapter if/when the remote BFF path ships. ONE shape here.
    const ev = toAppEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec: { root: 'r', elements: {} } });
    expect(ev).toEqual({ kind: 'activity-snapshot', spec: { root: 'r', elements: {} } });
  });

  it('carries optional token and cost totals through on RUN_FINISHED', () => {
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

  it('fails closed on a reserved-key STATE_SNAPSHOT', () => {
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

  it('lets a non-retriable code override an explicit retriable true wire flag', () => {
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

  it('fails closed on a reserved-key ACTIVITY_SNAPSHOT spec', () => {
    const ev = toAppEvent({
      type: EventType.ACTIVITY_SNAPSHOT,
      spec: JSON.parse('{"constructor":1}'),
    });
    expect(ev).toMatchObject({ kind: 'run-error', retriable: false });
  });

  it('rejects a JSON scalar ACTIVITY_SNAPSHOT because activity carries AppSpec', () => {
    expect(toAppEvent({ type: EventType.ACTIVITY_SNAPSHOT, spec: 0 })).toMatchObject({
      kind: 'run-error',
      retriable: false,
    });
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
  it('fails closed on a reserved-key STATE_DELTA op value with a non-retriable run error', () => {
    // An op `value` bearing an own reserved key is rejected by JsonPatchArraySchema (its value
    // Members pass through the same guard before the delta can fold into the store.
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

  it('fails closed instead of fabricating required fields on recognized events', () => {
    const malformed: readonly unknown[] = [
      { type: EventType.RUN_STARTED, threadId: 't' },
      { type: EventType.RUN_FINISHED, threadId: 1, runId: 'r' },
      { type: EventType.RUN_ERROR, message: {} },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 1 },
      { type: EventType.TOOL_CALL_RESULT, toolCallId: 't', content: 1 },
      { type: EventType.RAW },
    ];
    for (const raw of malformed) {
      expect(toAppEvent(raw)).toMatchObject({ kind: 'run-error', retriable: false });
    }
    expect(toAppEvent({ type: EventType.TEXT_MESSAGE_CONTENT, delta: 'ok' })).toEqual({
      kind: 'text-delta',
      messageId: '',
      delta: 'ok',
    });
  });

  it('is total for hostile event objects and hostile visibility conversions', () => {
    const throwingType = new Proxy(
      {},
      {
        get() {
          throw new Error('getter denied');
        },
      },
    );
    const hostilePayload = {
      toJSON() {
        throw new Error('json denied');
      },
      toString() {
        throw new Error('string denied');
      },
    };
    expect(() => toAppEvent(throwingType)).not.toThrow();
    expect(toAppEvent(throwingType)).toMatchObject({ kind: 'run-error', retriable: false });
    const visibility = toAppEvent({ type: EventType.RAW, event: hostilePayload });
    expect(visibility).toEqual({ kind: 'visibility', note: '', visClass: 'modelVisible' });
    for (const event of [Symbol('raw'), () => undefined]) {
      const normalized = toAppEvent({ type: EventType.RAW, event });
      expect(normalized.kind).toBe('visibility');
      if (normalized.kind === 'visibility') expect(typeof normalized.note).toBe('string');
    }
  });

  it('observes every wire property once while normalizing recognized events', () => {
    const cases = [
      {
        raw: { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
        expected: { kind: 'run-started', threadId: 'thread', runId: 'run' },
      },
      {
        raw: { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' },
        expected: { kind: 'run-finished', threadId: 'thread', runId: 'run' },
      },
      {
        raw: { type: EventType.RUN_ERROR, message: 'failed', code: 'fatal', retriable: false },
        expected: {
          kind: 'run-error',
          message: 'failed',
          code: 'fatal',
          retriable: false,
        },
      },
      {
        raw: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: 'text' },
        expected: { kind: 'text-delta', messageId: 'message', delta: 'text' },
      },
      {
        raw: {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'call',
          toolName: 'tool',
          content: 'done',
          isError: false,
          error: 'detail',
          denied: false,
        },
        expected: {
          kind: 'tool-result',
          toolCallId: 'call',
          toolName: 'tool',
          content: 'done',
          isError: false,
          error: 'detail',
          denied: false,
        },
      },
      {
        raw: { type: EventType.STATE_SNAPSHOT, snapshot: { value: 1 } },
        expected: { kind: 'state-snapshot', snapshot: { value: 1 } },
      },
      {
        raw: { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/value', value: 1 }] },
        expected: {
          kind: 'state-delta',
          delta: [{ op: 'add', path: '/value', value: 1 }],
        },
      },
      {
        raw: { type: EventType.CUSTOM, name: 'note', value: 'visible', visClass: 'localOnly' },
        expected: { kind: 'visibility', note: 'visible', visClass: 'localOnly' },
      },
      {
        raw: { type: EventType.RAW, event: 'visible', visClass: 'modelOnly' },
        expected: { kind: 'visibility', note: 'visible', visClass: 'modelOnly' },
      },
      {
        raw: {
          type: EventType.ACTIVITY_SNAPSHOT,
          spec: { root: 'root', elements: {} },
        },
        expected: {
          kind: 'activity-snapshot',
          spec: { root: 'root', elements: {} },
        },
      },
    ];

    for (const { raw, expected } of cases) {
      const reads = new Map<PropertyKey, number>();
      const observed = new Proxy(raw, {
        get(target, property, receiver) {
          const count = (reads.get(property) ?? 0) + 1;
          reads.set(property, count);
          if (count > 1) throw new Error(`property reread: ${String(property)}`);
          return Reflect.get(target, property, receiver);
        },
      });
      expect(toAppEvent(observed)).toEqual(expected);
    }
  });

  it('exposes CONSUMED_KINDS through a non-Set immutable facade', () => {
    const runtime = CONSUMED_KINDS as Set<EventType>;
    expect(() => runtime.clear()).toThrow();
    expect(() => Set.prototype.delete.call(runtime, EventType.STATE_DELTA)).toThrow();
    expect(CONSUMED_KINDS.has(EventType.STATE_DELTA)).toBe(true);
  });

  it('keeps the consumed kind vocabulary exactly aligned with the normalizer', () => {
    // Derived from the switch itself, not from a second hand-written list: every kind
    // normalizeObject has a case for returns a non-passthrough AppEvent even for a bare
    // {type} event (an unsatisfied case returns malformed(), i.e. kind 'run-error');
    // every kind that falls to `default` returns kind 'passthrough'. Two literal lists
    // can only agree with each other, never with the code they claim to describe.
    const handledByNormalizer = Object.values(EventType).filter(
      (type) => toAppEvent({ type }).kind !== 'passthrough',
    );
    expect([...CONSUMED_KINDS].sort()).toEqual([...handledByNormalizer].sort());
  });
});
