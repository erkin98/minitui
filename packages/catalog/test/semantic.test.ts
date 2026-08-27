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

  it('rejects an UNKNOWN prop key even when its value is a dynamic marker (blanking keeps the key)', () => {
    // The dynamic marker blanks the VALUE to undefined but keeps the KEY, so an
    // off-catalog key carrying a { $state } value is still caught by the strict
    // schema — the blanking does not smuggle an unknown key past the prop gate.
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'Button', props: { label: 'Go', evil: { $state: '/x' } } } },
    };
    expect(codes(checkSemantics(spec, cat, { x: 1 }))).toContain('bad-props');
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

describe('off-grammar prop-value operators', () => {
  // The renderer resolves prop values recursively and CALLS the function named by
  // a $computed marker; the no-code moat allows only the taught state/binding/
  // conditional markers and rejects $computed + any unknown $-operator at any depth.
  const st = { p: 1, title: 'Go', inputs: ['/abs/a.mp4'] };

  it('(a) rejects a top-level $computed prop expression (it executes a function)', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: { b: { type: 'Button', props: { label: { $computed: 'fn', args: { x: 1 } } } } },
      }),
    );
    expect(codes(checkSemantics(spec, cat, st))).toContain('off-grammar-operator');
  });

  it('(b) rejects a $computed nested under a $cond branch (a top-level check is bypassable)', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: {
          b: {
            type: 'Button',
            props: {
              label: {
                $cond: { $state: '/p', gt: 0 },
                $then: { $computed: 'exfil', args: { s: { $state: '/p' } } },
                $else: 'y',
              },
            },
          },
        },
      }),
    );
    expect(codes(checkSemantics(spec, cat, st))).toContain('off-grammar-operator');
  });

  it('(c) rejects an unknown/custom $-operator', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: { b: { type: 'Button', props: { label: { $danger: 'x' } } } },
      }),
    );
    expect(codes(checkSemantics(spec, cat, st))).toContain('off-grammar-operator');
  });

  it('(d) rejects a $computed nested inside an array and inside a plain object', () => {
    const inArray: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: { b: { type: 'Button', props: { label: [{ $computed: 'fn' }] } } },
      }),
    );
    expect(codes(checkSemantics(inArray, cat, st))).toContain('off-grammar-operator');
    const inObject: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: { b: { type: 'Button', props: { label: { nested: { $computed: 'fn' } } } } },
      }),
    );
    expect(codes(checkSemantics(inObject, cat, st))).toContain('off-grammar-operator');
  });

  it('passes the taught markers ($state / $item / $template) and a legit $cond branch', () => {
    const mk = (label: unknown): AppSpec =>
      JSON.parse(
        JSON.stringify({ root: 'b', elements: { b: { type: 'Button', props: { label } } } }),
      );
    for (const label of [
      { $state: '/p' },
      { $item: 'name' },
      { $template: 'hi ${/title}' },
      { $cond: { $state: '/p', gt: 0 }, $then: 'a', $else: 'b' },
    ]) {
      expect(codes(checkSemantics(mk(label), cat, st))).not.toContain('off-grammar-operator');
    }
  });
});

describe('missing required prop', () => {
  it('flags a genuinely-required (non-nullable, no-default) prop the spec omits', () => {
    // Button.label is a required non-nullable string; omitting it is incomplete
    // content the renderer cannot fill from a default.
    const spec: AppSpec = JSON.parse(
      JSON.stringify({ root: 'b', elements: { b: { type: 'Button', props: {} } } }),
    );
    expect(codes(checkSemantics(spec, cat, {}))).toContain('missing-required-prop');
  });

  it('does NOT flag a required prop supplied as a { $state } binding (present though blanked)', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'Button', props: { label: { $state: '/title' } } } },
    };
    expect(codes(checkSemantics(spec, cat, { title: 'Go' }))).not.toContain(
      'missing-required-prop',
    );
  });

  it('does NOT flag a nullable-required prop the spec omits (legitimately omittable)', () => {
    // A nullable-required styling prop is omittable — the shipped std defs carry many.
    const nullableCat = defineMinituiCatalog({
      id: 'nullable',
      components: {
        Styled: {
          props: z.object({ color: z.string().nullable(), size: z.number().default(1) }).strict(),
          slots: [],
          description: 'x',
          trustTier: 'display',
        },
      },
      actions: {},
    });
    const spec: AppSpec = { root: 's', elements: { s: { type: 'Styled', props: {} } } };
    expect(codes(checkSemantics(spec, nullableCat, {}))).not.toContain('missing-required-prop');
  });
});
