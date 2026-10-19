import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeSession,
  rejectionRecorder,
  scriptedModel,
  textTurn,
  type CallScript,
} from './helpers/sdk-model.js';

// The session on the installed `streamText`, driven by a real scripted model object. A normal turn must
// end without an unhandled rejection: one would stop the process.
describe('a turn on the installed SDK leaves no unhandled rejection', () => {
  const recorder = rejectionRecorder();
  beforeEach(() => recorder.attach());
  afterEach(() => recorder.detach());

  async function run(scripts: readonly CallScript[], config = {}): Promise<string[]> {
    const { model } = scriptedModel(scripts);
    const session = makeSession({ model, config });
    const types: string[] = [];
    for await (const ev of session.submit('go')) types.push(ev.type);
    await recorder.settle();
    return types;
  }

  it('after a normal finish', async () => {
    const types = await run([{ chunks: textTurn('hello') }]);
    expect(types.at(-1)).toBe('RUN_FINISHED');
    expect(recorder.seen).toEqual([]);
  });

  it('after an errored provider stream', async () => {
    const types = await run([
      {
        chunks: [{ type: 'stream-start', warnings: [] }],
        end: { error: new Error('provider down') },
      },
    ]);
    expect(types.at(-1)).toBe('RUN_ERROR');
    expect(recorder.seen).toEqual([]);
  });

  it('after an errored stream that already delivered content', async () => {
    const types = await run([
      {
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'partial' },
        ],
        waitMs: 60,
        end: { error: new Error('provider dropped') },
      },
    ]);
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types.at(-1)).toBe('RUN_ERROR');
    expect(recorder.seen).toEqual([]);
  });

  it('after an idle timeout', async () => {
    const types = await run([{ end: 'hang' }], { idleTimeoutMs: 50, streamMaxRetries: 0 });
    expect(types.at(-1)).toBe('RUN_ERROR');
    expect(recorder.seen).toEqual([]);
  });

  it('after the consumer breaks early', async () => {
    const { model } = scriptedModel([{ chunks: textTurn('hello') }]);
    const session = makeSession({ model });
    for await (const _ of session.submit('go')) break;
    await recorder.settle();
    expect(recorder.seen).toEqual([]);
  });
});
