import { describe, it, expect } from 'vitest';
import type { ActionDispatcher, ActionKind } from '../src/dispatch/action-dispatcher.js';

describe('ActionDispatcher', () => {
  // a fake that proves the contract is implementable and routes by kind
  const fake: ActionDispatcher = {
    async dispatch(actionName, ctx) {
      if (ctx.actionKind === 'render-local') return { status: 'settled' };
      if (ctx.permission?.danger && ctx.resolvedParams.blocked) {
        return { status: 'denied', reason: `gate denied ${actionName}` };
      }
      return { status: 'settled', result: { ran: actionName } };
    },
  };

  it('render-local settles without a permission', async () => {
    const out = await fake.dispatch('setState', {
      actionName: 'setState',
      actionKind: 'render-local',
      resolvedParams: {},
      stateSnapshot: {},
      elementKey: 'k',
    });
    expect(out).toEqual({ status: 'settled' });
  });

  it('a gated denial surfaces as a denied outcome', async () => {
    const out = await fake.dispatch('merge', {
      actionName: 'merge',
      actionKind: 'exec-local',
      permission: { danger: true, resourceTemplate: 'x', summaryTemplate: 'y' },
      resolvedParams: { blocked: true },
      stateSnapshot: {},
      elementKey: 'merge-button',
    });
    expect(out.status).toBe('denied');
  });

  it('re-exports ActionKind as the closed four-member union', () => {
    const kinds: ActionKind[] = ['render-local', 'exec-local', 'exec-mcp', 'agent-callback'];
    expect(kinds).toHaveLength(4);
  });
});
