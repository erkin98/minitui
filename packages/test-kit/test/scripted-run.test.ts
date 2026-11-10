import { describe, it, expect } from 'vitest';
import { scriptedRun } from '../src/llm/scripted-run.js';

describe('scriptedRun (zero-arg fluent builder)', () => {
  it('builds an ordered chunk script', () => {
    const run = scriptedRun()
      .text('building')
      .toolCall('lookup', { q: 'codec' }, 't1')
      .toolResult('t1', { ok: true })
      .finish('stop');
    expect(run.chunks().map((c) => c.type)).toEqual(['text', 'tool-call', 'tool-result', 'finish']);
  });

  it('threads the last tool-call id when toolResult omits one', () => {
    const chunks = scriptedRun()
      .toolCall('run', {})
      .toolResult(undefined, { exitCode: 0 })
      .chunks();
    expect(chunks[0]).toMatchObject({ type: 'tool-call', toolCallId: 't1' });
    expect(chunks[1]).toMatchObject({ type: 'tool-result', toolCallId: 't1' });
  });

  it('carries the matching toolName onto the tool-result chunk', () => {
    const chunks = scriptedRun()
      .toolCall('merge', {}, 'm1')
      .toolResult('m1', { exitCode: 0 })
      .chunks();
    expect(chunks[1]).toMatchObject({ type: 'tool-result', toolName: 'merge', isError: false });
  });

  it('refuses a toolResult with no id and no preceding toolCall', () => {
    expect(() => scriptedRun().toolResult(undefined, {})).toThrow(/no preceding toolCall/);
  });

  it('is immutable: each step returns a new builder', () => {
    const base = scriptedRun().text('a');
    const branch = base.text('b');
    expect(base.chunks()).toHaveLength(1);
    expect(branch.chunks()).toHaveLength(2);
  });

  it('builds a real provider that replays the script', async () => {
    const provider = scriptedRun().text('hi').finish().provider();
    const types: string[] = [];
    for await (const c of provider.streamChat({}, new AbortController().signal)) types.push(c.type);
    expect(types).toEqual(['text', 'finish']);
  });

  it('scripts a non-retriable provider error', () => {
    const run = scriptedRun().text('starting').error('provider crashed', false);
    expect(run.chunks().at(-1)).toEqual({
      type: 'error',
      message: 'provider crashed',
      retriable: false,
    });
  });

  it('carries retryAfterMs on a retriable error when given', () => {
    const run = scriptedRun().error('rate limited', true, 2000);
    expect(run.chunks().at(-1)).toEqual({
      type: 'error',
      message: 'rate limited',
      retriable: true,
      retryAfterMs: 2000,
    });
  });
});
