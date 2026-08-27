import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '@minitui/catalog';
import { checkVisibility } from '../src/semantic/check-visibility.js';
import type { Spec } from '../src/spec-types.js';

// A secret Token (builder forces localOnly) + a Box + a user-driven run action
// (a2ui default clientOnly). The agent may not widen any of them.
const catalog = defineMinituiCatalog({
  id: 'vis',
  components: {
    Token: {
      props: z.object({ token: z.string() }).strict(),
      slots: [],
      description: 'secret token field',
      trustTier: 'interactive',
      secret: true,
    },
    Box: {
      props: z.object({}).strict(),
      slots: ['default'],
      description: 'box',
      trustTier: 'display',
    },
  },
  actions: {
    run: {
      params: z.object({}),
      description: 'run',
      kind: 'exec-local',
      permission: { danger: false, resourceTemplate: 'echo', summaryTemplate: 'Echo' },
      callableFrom: 'clientOnly',
    },
  },
});

describe('checkVisibility (ledger §Z6)', () => {
  it('passes a spec that never touches visibility (the catalog class governs silently)', () => {
    const spec: Spec = {
      root: 'b',
      elements: { b: { type: 'Box', props: {}, on: { press: { action: 'run' } } } },
      state: {},
    };
    expect(checkVisibility(spec, catalog)).toEqual([]);
  });

  it("rejects an agent attempt to WIDEN a secret component's visibility (localOnly -> remoteOnly)", () => {
    // `visibility` is an excess field the wire SpecElement does not model — smuggled
    // past strict-props (which only checks `props`). This gate is the one that bites.
    const spec = {
      root: 't',
      elements: { t: { type: 'Token', props: { token: '' }, visibility: 'remoteOnly' } },
      state: {},
    } as unknown as Spec;
    const issues = checkVisibility(spec, catalog);
    expect(issues.map((i) => i.code)).toContain('visibility_widened');
    expect(issues[0]?.elementKey).toBe('t');
  });

  it("rejects an agent attempt to widen an action's callableFrom (clientOnly -> remoteOnly)", () => {
    const spec = {
      root: 'b',
      elements: {
        b: { type: 'Box', props: {}, on: { press: { action: 'run', callableFrom: 'remoteOnly' } } },
      },
      state: {},
    } as unknown as Spec;
    expect(checkVisibility(spec, catalog).map((i) => i.code)).toContain('visibility_widened');
  });

  it("recurses into onSuccess/onError callbacks so a nested action's widen is caught (§Z87)", () => {
    // json-render EXECUTES onSuccess.action as a real secondary action; a walk that
    // stops at the top-level binding is blind to it. The recursion in bindingsOf makes
    // the widen-check bite on the nested `run` (clientOnly -> remoteOnly) exactly as on
    // a top-level binding — defense-in-depth behind plan-13's prepareSpec strip.
    const spec = {
      root: 'b',
      elements: {
        b: {
          type: 'Box',
          props: {},
          on: {
            press: {
              action: 'run',
              onSuccess: { action: { action: 'run', callableFrom: 'remoteOnly' } },
            },
          },
        },
      },
      state: {},
    } as unknown as Spec;
    expect(checkVisibility(spec, catalog).map((i) => i.code)).toContain('visibility_widened');
  });

  it('recurses into an onError callback too, not only onSuccess', () => {
    // The onSuccess arm is covered above; the walk must also descend onError, which
    // the lib runs on failure. Parsed from raw JSON so the nested action object and
    // the smuggled callableFrom are honest untrusted input, not a typechecked literal.
    const raw = `{
      "root": "b",
      "elements": {
        "b": {
          "type": "Box",
          "props": {},
          "on": {
            "press": {
              "action": "run",
              "onError": { "action": { "action": "run", "callableFrom": "remoteOnly" } }
            }
          }
        }
      },
      "state": {}
    }`;
    const spec: Spec = JSON.parse(raw);
    expect(checkVisibility(spec, catalog).map((i) => i.code)).toContain('visibility_widened');
  });

  it('allows a NARROWER request — the agent may only tighten, never widen', () => {
    const spec = {
      root: 'b',
      elements: { b: { type: 'Box', props: {}, visibility: 'localOnly' } },
      state: {},
    } as unknown as Spec;
    expect(checkVisibility(spec, catalog)).toEqual([]);
  });
});
