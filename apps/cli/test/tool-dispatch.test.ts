import { describe, it, expect } from 'vitest';
import { videoMergeCatalog } from '@minitui/catalog';
import type { DispatchContext, ActionOutcome } from '@minitui/renderer-core';
import type { ExecEvent } from '@minitui/types';
import { makeToolDispatch } from '../src/tool-dispatch.js';

function recordingHost(outcome: ActionOutcome): {
  host: { dispatchFromModel: (name: string, ctx: DispatchContext) => Promise<ActionOutcome> };
  calls: Array<{ name: string; ctx: DispatchContext }>;
} {
  const calls: Array<{ name: string; ctx: DispatchContext }> = [];
  return {
    calls,
    host: {
      dispatchFromModel: (name, ctx) => {
        calls.push({ name, ctx });
        return Promise.resolve(outcome);
      },
    },
  };
}

const request = (toolName: string, args: Record<string, never> = {}) => ({
  toolCallId: 'call-1',
  toolName,
  args,
});
const live = (): AbortSignal => new AbortController().signal;

describe('makeToolDispatch', () => {
  it('refuses a turn that is already aborted and never reaches the host', async () => {
    const { host, calls } = recordingHost({ status: 'settled' });
    const controller = new AbortController();
    controller.abort();
    const result = await makeToolDispatch(host, () => {}).dispatch(
      request('merge'),
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, isError: true, error: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it.each(['setState', 'not-an-action'])(
    'refuses %s at the port, as denied, without reaching the host',
    async (name) => {
      const { host, calls } = recordingHost({ status: 'settled' });
      const result = await makeToolDispatch(host, () => {}).dispatch(request(name), live());
      expect(result).toMatchObject({ ok: false, isError: true, denied: true });
      expect(calls).toEqual([]);
    },
  );

  it('hands the host a context built from the catalog and the model arguments', async () => {
    const { host, calls } = recordingHost({ status: 'settled' });
    const seen: ExecEvent[] = [];
    const onEvent = (ev: ExecEvent): void => {
      seen.push(ev);
    };
    await makeToolDispatch(host, onEvent).dispatch(
      { toolCallId: 'c', toolName: 'merge', args: { codec: 'h264' } },
      live(),
    );
    const call = calls[0];
    expect(call?.name).toBe('merge');
    expect(call?.ctx).toMatchObject({
      actionName: 'merge',
      actionKind: 'exec-local',
      permission: videoMergeCatalog.permissionOf('merge'),
      resolvedParams: { codec: 'h264' },
      stateSnapshot: {},
      elementKey: '',
    });
    call?.ctx.onEvent?.({ kind: 'progress', value: 0.5 });
    expect(seen).toEqual([{ kind: 'progress', value: 0.5 }]);
  });

  it('copies the arguments, so the host cannot change what the model sent', async () => {
    const { host, calls } = recordingHost({ status: 'settled' });
    const args = { codec: 'h264' };
    await makeToolDispatch(host, () => {}).dispatch(
      { toolCallId: 'c', toolName: 'merge', args },
      live(),
    );
    expect(calls[0]?.ctx.resolvedParams).not.toBe(args);
  });

  it('maps a settled outcome to its result as JSON, and no result to null', async () => {
    const withResult = await makeToolDispatch(
      recordingHost({ status: 'settled', result: { done: true } }).host,
      () => {},
    ).dispatch(request('merge'), live());
    expect(withResult).toMatchObject({ ok: true, isError: false, content: '{"done":true}' });
    const without = await makeToolDispatch(
      recordingHost({ status: 'settled' }).host,
      () => {},
    ).dispatch(request('merge'), live());
    expect(without).toMatchObject({ ok: true, content: 'null' });
  });

  it('maps a denied outcome to a denied error with the host reason', async () => {
    const result = await makeToolDispatch(
      recordingHost({ status: 'denied', reason: 'action is not callable by the model' }).host,
      () => {},
    ).dispatch(request('merge'), live());
    expect(result).toMatchObject({
      ok: false,
      denied: true,
      error: 'action is not callable by the model',
    });
  });

  it('maps an awaiting outcome and a failed outcome to errors that carry their text', async () => {
    const awaiting = await makeToolDispatch(
      recordingHost({ status: 'awaiting', requestId: 'req-9' }).host,
      () => {},
    ).dispatch(request('merge'), live());
    expect(awaiting).toMatchObject({ ok: false, isError: true });
    expect(awaiting.error).toContain('req-9');
    const failed = await makeToolDispatch(
      recordingHost({
        status: 'failed',
        fault: { actionKey: 'merge', exitCode: 1, stderrExcerpt: 'codec missing' },
      }).host,
      () => {},
    ).dispatch(request('merge'), live());
    expect(failed).toMatchObject({ ok: false, error: 'codec missing' });
  });

  it('an earlier turn that ended does not cancel a later dispatch', async () => {
    const { host, calls } = recordingHost({ status: 'settled' });
    const port = makeToolDispatch(host, () => {});
    const first = new AbortController();
    await port.dispatch(request('merge'), first.signal);
    first.abort();
    const second = await port.dispatch(request('merge'), live());
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
