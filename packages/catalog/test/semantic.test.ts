import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '../src/define-catalog.js';
import { checkSemantics, type SemanticIssue } from '../src/validate/semantic.js';
import type { AppSpec } from '../src/contract/spec.js';

const cat = defineMinituiCatalog({
  id: 'demo',
  components: {
    Button: {
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'btn',
      trustTier: 'interactive',
    },
  },
  actions: {
    merge: {
      params: z.object({}),
      description: 'merge',
      kind: 'exec-local',
      permission: {
        danger: true,
        resourceTemplate: 'ffmpeg -i ${/inputs/0}',
        summaryTemplate: 'Merge',
      },
    },
    badLocal: {
      params: z.object({}),
      description: 'render-local but dangerous (contradiction)',
      kind: 'render-local',
      permission: { danger: true, resourceTemplate: 'x', summaryTemplate: 'y' },
    },
  },
});

const codes = (issues: readonly SemanticIssue[]) => issues.map((i) => i.code);

describe('checkSemantics', () => {
  it('passes a clean dangerous-but-gated spec with resolvable bindings', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: {
          type: 'Button',
          props: { label: 'Go' },
          on: { press: { action: 'merge', params: { inputs: { $state: '/inputs' } } } },
        },
      },
    };
    expect(checkSemantics(spec, cat, { inputs: ['/abs/a.mp4'] })).toEqual([]);
  });

  it('flags a render-local action that carries a danger permission (contradiction)', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'badLocal' } } },
      },
    };
    expect(codes(checkSemantics(spec, cat, {}))).toContain('danger-without-confirm');
  });

  it('flags a resourceTemplate binding that does not resolve against state', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },
      },
    };
    // /inputs/0 is missing from the bound state document
    expect(codes(checkSemantics(spec, cat, { inputs: [] }))).toContain('bad-binding');
  });

  it('flags a dynamic action param whose { $state } pointer does not resolve', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: {
          type: 'Button',
          props: { label: 'Go' },
          on: { press: { action: 'merge', params: { output: { $state: '/missing' } } } },
        },
      },
    };
    expect(codes(checkSemantics(spec, cat, { inputs: ['/abs/a.mp4'] }))).toContain('bad-binding');
  });

  it('flags a dynamic action param whose { $bindState } pointer does not resolve', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: {
          type: 'Button',
          props: { label: 'Go' },
          on: { press: { action: 'merge', params: { output: { $bindState: '/missing' } } } },
        },
      },
    };
    expect(codes(checkSemantics(spec, cat, { inputs: ['/abs/a.mp4'] }))).toContain('bad-binding');
  });

  it('flags a prop { $state } binding that does not resolve', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'Button', props: { label: { $state: '/nope' } } } },
    };
    expect(codes(checkSemantics(spec, cat, { inputs: ['/abs/a.mp4'] }))).toContain('bad-binding');
  });

  it('a dynamic marker on a KNOWN prop key is not a bad-props false positive', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'Button', props: { label: { $state: '/title' } } } },
    };
    expect(checkSemantics(spec, cat, { title: 'Go', inputs: ['/abs/a.mp4'] })).toEqual([]);
  });

  it('flags unknown props the lenient core validator skips', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: {
          type: 'Button',
          props: { label: 'Go', evil: true },
          on: { press: { action: 'merge' } },
        },
      },
    };
    expect(codes(checkSemantics(spec, cat, { inputs: ['/abs/a.mp4'] }))).toContain('bad-props');
  });

  it('rejects an unknown prop on a std-style plain (stripping) component — ingest strictens it', () => {
    // A std def (e.g. json-render's ProgressBar) is a PLAIN z.object, not .strict().
    // Without ingest normalization, .partial().safeParse would STRIP the unknown key
    // (success) and the off-catalog prop would survive into the rendered spec.
    // defineMinituiCatalog strictens plain ZodObjects at ingest, so the gate rejects it.
    const stdish = defineMinituiCatalog({
      id: 'stdish',
      components: {
        // plain z.object (stripping) — mirrors an adopted std def, deliberately NOT .strict()
        Meter: {
          props: z.object({ progress: z.number() }),
          slots: [],
          description: 'm',
          trustTier: 'display',
        },
      },
      actions: {},
    });
    const spec: AppSpec = {
      root: 'm',
      elements: { m: { type: 'Meter', props: { progress: 0.5, evil: true } } },
    };
    expect(codes(checkSemantics(spec, stdish, {}))).toContain('bad-props');
  });
});
