import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES,
  EventTypeSchema,
  AgentEventSchema,
  TokenUsageSchema,
  type AgentEvent,
} from '../src/events.js';

describe('EventType', () => {
  it('is exactly the active AG-UI families minitui consumes, in order', () => {
    // Exact-equality (not containment): a dropped or reordered family reds this,
    // and it locks the vocabulary the AgentEvent discriminants must mirror.
    expect(EVENT_TYPES).toEqual([
      'RUN_STARTED',
      'RUN_FINISHED',
      'RUN_ERROR',
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'ACTIVITY_SNAPSHOT',
      'CUSTOM',
    ]);
    for (const t of EVENT_TYPES) expect(EventTypeSchema.parse(t)).toBe(t);
  });
});

describe('AgentEvent', () => {
  it('parses run lifecycle events carrying required threadId + runId (AG-UI verbatim)', () => {
    const ev: AgentEvent = { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
    expect(AgentEventSchema.safeParse({ type: 'RUN_FINISHED', threadId: 't1' }).success).toBe(
      false,
    );
  });
  it('parses a RUN_FINISHED with optional minitui-owned usage token counts', () => {
    expect(AgentEventSchema.parse({ type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }).type).toBe(
      'RUN_FINISHED',
    );
    const ev: AgentEvent = {
      type: 'RUN_FINISHED',
      threadId: 't1',
      runId: 'r1',
      usage: { inputTokens: 120, outputTokens: 45 },
    };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
  });
  it('rejects negative, fractional, and unsafe-integer usage token counts', () => {
    const base = { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' } as const;
    expect(
      AgentEventSchema.safeParse({ ...base, usage: { inputTokens: -1, outputTokens: 0 } }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({ ...base, usage: { inputTokens: 1.5, outputTokens: 0 } }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        ...base,
        usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({ ...base, usage: { inputTokens: 0, outputTokens: 12 } }).success,
    ).toBe(true);
  });
  it('TokenUsageSchema rejects invalid counts and accepts valid ones', () => {
    expect(TokenUsageSchema.safeParse({ inputTokens: -1, outputTokens: 0 }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ inputTokens: 1.5, outputTokens: 0 }).success).toBe(false);
    expect(TokenUsageSchema.safeParse({ inputTokens: 12, outputTokens: 34 }).success).toBe(true);
  });
  it('parses a STATE_DELTA carrying RFC-6902 patches', () => {
    const ev: AgentEvent = {
      type: 'STATE_DELTA',
      delta: [{ op: 'replace', path: '/merge/progress', value: 42 }],
    };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
  });
  it('parses TOOL_CALL_START via toolCallName and strips a stray toolName alias', () => {
    const ev: AgentEvent = {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'merge_videos',
    };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
    // A payload MISSING the canonical toolCallName is rejected (what the old test really proved).
    expect(
      AgentEventSchema.safeParse({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolName: 'x' })
        .success,
    ).toBe(false);
    // A stray toolName alias alongside the canonical name is STRIPPED, not rejected (strip-by-design).
    const stripped = AgentEventSchema.parse({
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'merge_videos',
      toolName: 'x',
    });
    expect(stripped).toEqual(ev);
    expect('toolName' in stripped).toBe(false);
  });
  it('parses an ACTIVITY_SNAPSHOT carrying a generated spec', () => {
    const ev: AgentEvent = {
      type: 'ACTIVITY_SNAPSHOT',
      spec: { root: 'a', elements: { a: { type: 'Box', props: {} } } },
    };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
  });
  it('parses a RUN_ERROR with a message and optional code', () => {
    expect(AgentEventSchema.parse({ type: 'RUN_ERROR', message: 'overflow' }).type).toBe(
      'RUN_ERROR',
    );
    expect(
      AgentEventSchema.parse({ type: 'RUN_ERROR', message: 'overflow', code: 'CTX_OVERFLOW' }).type,
    ).toBe('RUN_ERROR');
  });
  it('preserves the tool observation shape including the optional denied bit', () => {
    // The model-facing observation (agentObservation) rides TOOL_CALL_RESULT — its
    // toolName/error/denied extensions must SURVIVE parse so a host permission-gate refusal stays
    // distinguishable from an execution failure (not flattened into error text).
    const ev: AgentEvent = {
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      toolName: 'merge',
      content: '',
      isError: true,
      error: 'permission denied',
      denied: true,
    };
    expect(AgentEventSchema.parse(ev)).toEqual(ev);
  });
  it('rejects an unknown event type', () => {
    expect(AgentEventSchema.safeParse({ type: 'WAT' }).success).toBe(false);
  });
});
