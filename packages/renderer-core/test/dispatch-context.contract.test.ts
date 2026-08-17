import { describe, it, expect } from 'vitest';
import type { DispatchContext } from '../src/dispatch/dispatch-context.js';
import type { ExecEvent } from '@minitui/types';

describe('DispatchContext', () => {
  it('carries RESOLVED params, kind, optional permission, snapshot, and provenance', () => {
    const ctx: DispatchContext = {
      actionName: 'merge',
      actionKind: 'exec-local',
      permission: {
        danger: true,
        resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1}',
        summaryTemplate: 'Merge 2 videos',
      },
      // RESOLVED against state — concrete absolute paths, never the ${...} template
      resolvedParams: { inputs: ['/abs/a.mp4', '/abs/b.mp4'], out: '/abs/out.mp4' },
      stateSnapshot: { inputs: ['/abs/a.mp4', '/abs/b.mp4'] },
      elementKey: 'merge-button',
    };

    expect(ctx.actionKind).toBe('exec-local');
    expect(ctx.permission?.danger).toBe(true);
    expect(ctx.resolvedParams.inputs).toEqual(['/abs/a.mp4', '/abs/b.mp4']);
    expect(ctx.elementKey).toBe('merge-button');
  });

  it('permission is optional for render-local actions', () => {
    const local: DispatchContext = {
      actionName: 'setState',
      actionKind: 'render-local',
      resolvedParams: { path: '/codec', value: 'h264' },
      stateSnapshot: {},
      elementKey: 'codec-select',
    };
    expect(local.permission).toBeUndefined();
  });

  it('carries an optional onEvent correlation callback for exec progress (§Z2)', () => {
    const seen: ExecEvent[] = [];
    const ctx: DispatchContext = {
      actionName: 'merge',
      actionKind: 'exec-local',
      resolvedParams: {},
      stateSnapshot: {},
      elementKey: 'merge-button',
      onEvent: (ev) => seen.push(ev),
    };
    // the dispatcher streams exec progress through this seam (§Z2)
    ctx.onEvent?.({ kind: 'progress', value: 0.5 });
    expect(seen).toEqual([{ kind: 'progress', value: 0.5 }]);
  });
});
