import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineAction,
  requiresPermission,
  type MinituiActionDef,
} from '../src/contract/catalog-action.js';

describe('MinituiActionDef', () => {
  it('is a json-render ActionDefinition plus kind + permission', () => {
    const merge: MinituiActionDef<{ inputs: string[] }> = {
      params: z.object({ inputs: z.array(z.string()) }),
      description: 'Merge videos with ffmpeg',
      kind: 'exec-local',
      permission: {
        danger: true,
        resourceTemplate: 'ffmpeg -i ${/inputs/0}',
        summaryTemplate: 'Merge videos',
      },
    };
    expect(merge.kind).toBe('exec-local');
    expect(merge.params.safeParse({ inputs: ['a.mp4'] }).success).toBe(true);
  });

  it('a render-local action carries no permission', () => {
    const local = defineAction({
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'Set state',
      kind: 'render-local',
    });
    expect(local.permission).toBeUndefined();
  });

  it('carries an optional builder-owned callableFrom visibility class', () => {
    const remote = defineAction({
      params: z.object({}),
      description: 'agent-driven callback',
      kind: 'agent-callback',
      permission: { danger: false, resourceTemplate: 'x', summaryTemplate: 'y' },
      callableFrom: 'remoteOnly',
    });
    expect(remote.callableFrom).toBe('remoteOnly');
  });
});

describe('requiresPermission', () => {
  it('is false only for render-local', () => {
    expect(requiresPermission('render-local')).toBe(false);
    expect(requiresPermission('exec-local')).toBe(true);
    expect(requiresPermission('exec-mcp')).toBe(true);
    expect(requiresPermission('agent-callback')).toBe(true);
  });
});
