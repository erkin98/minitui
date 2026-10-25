import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { JsonValue } from '@minitui/types';
import { defineMinituiCatalog } from '../src/define-catalog.js';
import { gateCatalog } from './malformed-specs.js';
import { checkSemantics, type SemanticIssue } from '../src/validate/semantic.js';
import type { AppSpec } from '../src/contract/spec.js';
import { videoMergeCatalog } from '../src/catalogs/video-merge.js';

const codes = (issues: readonly SemanticIssue[]) => issues.map((i) => i.code);

describe('action params are checked at generation', () => {
  const state: JsonValue = {
    inputs: ['/abs/a.mp4', '/abs/b.mp4'],
    codec: 'h264',
    output: '/abs/out.mp4',
    pick: true,
    index: 0,
    todos: [],
    merge: { progress: 0, status: '' },
  };
  const press = (action: string, params?: Record<string, JsonValue>): AppSpec => ({
    root: 'b',
    elements: {
      b: {
        type: 'Button',
        props: { label: 'Go' },
        on: { press: params === undefined ? { action } : { action, params } },
      },
    },
  });
  const check = (spec: AppSpec) => checkSemantics(spec, videoMergeCatalog, state);
  const messagesOf = (issues: readonly SemanticIssue[], code: SemanticIssue['code']) =>
    issues.filter((i) => i.code === code).map((i) => i.message);

  it.each([
    ['merge with no params', press('merge'), ['inputs', 'codec', 'output']],
    ['merge with empty params', press('merge', {}), ['inputs', 'codec', 'output']],
    [
      'merge with one input',
      press('merge', { inputs: ['/abs/a.mp4'], codec: 'h264', output: '/abs/out.mp4' }),
      ['inputs'],
    ],
    [
      'merge with a numeric codec',
      press('merge', { inputs: ['/abs/a.mp4', '/abs/b.mp4'], codec: 5, output: '/abs/out.mp4' }),
      ['codec'],
    ],
    ['setState without statePath', press('setState', { value: 1 }), ['statePath']],
  ])('refuses %s and names the param', (_name, spec, named) => {
    const messages = messagesOf(check(spec), 'bad-params');
    expect(messages.length).toBeGreaterThan(0);
    for (const param of named) {
      expect(
        messages.some((m) => m.includes(`"${param}"`)),
        param,
      ).toBe(true);
    }
  });

  it.each([
    [
      'state references',
      press('merge', {
        inputs: { $state: '/inputs' },
        codec: { $state: '/codec' },
        output: { $state: '/output' },
      }),
    ],
    [
      'a reference to a number',
      press('removeState', { statePath: '/todos', index: { $state: '/index' } }),
    ],
    [
      'pushState with $id',
      press('pushState', { statePath: '/todos', value: { id: '$id', t: 'x' } }),
    ],
    [
      'removeState with $index',
      press('removeState', { statePath: '/todos', index: { $index: true } }),
    ],
    [
      'removeState with an $item path',
      press('removeState', { statePath: { $item: '' }, index: 0 }),
    ],
  ])('accepts %s', (_name, spec) => {
    expect(codes(check(spec))).not.toContain('bad-params');
    expect(check(spec)).toEqual([]);
  });

  const planCatalog = defineMinituiCatalog({
    id: 'plan',
    components: {
      Button: {
        props: z.object({ label: z.string() }).strict(),
        slots: [],
        description: 'btn',
        trustTier: 'interactive',
      },
    },
    actions: {
      plan: {
        params: z.object({
          inputs: z.array(z.string()).min(2),
          codec: z.string(),
          output: z.string(),
        }),
        description: 'plan',
        kind: 'exec-local',
        permission: { danger: false, resourceTemplate: 'plan', summaryTemplate: 'plan' },
      },
    },
  });

  it.each([
    [
      'literal params',
      press('plan', { inputs: ['/abs/a.mp4', '/abs/b.mp4'], codec: 'h264', output: '/abs/o.mp4' }),
    ],
    [
      'a complete conditional',
      press('plan', {
        inputs: ['/abs/a.mp4', '/abs/b.mp4'],
        codec: { $cond: { $state: '/pick' }, $then: 'h264', $else: 'vp9' },
        output: '/abs/o.mp4',
      }),
    ],
    [
      'markers inside a literal array',
      press('plan', {
        inputs: [{ $state: '/inputs/0' }, { $state: '/inputs/1' }],
        codec: 'h264',
        output: '/abs/o.mp4',
      }),
    ],
  ])('accepts %s for an action with no template holes', (_name, spec) => {
    expect(checkSemantics(spec, planCatalog, state)).toEqual([]);
  });

  it('accepts a marker nested in an object param', () => {
    const nested = defineMinituiCatalog({
      id: 'nested',
      components: {
        Button: {
          props: z.object({ label: z.string() }).strict(),
          slots: [],
          description: 'btn',
          trustTier: 'interactive',
        },
      },
      actions: {
        resize: {
          params: z.object({ size: z.object({ w: z.number() }) }),
          description: 'resize',
          kind: 'render-local',
        },
      },
    });
    const spec = press('resize', { size: { w: { $state: '/index' } } });
    expect(checkSemantics(spec, nested, state)).toEqual([]);
  });

  it('names an unknown param key of a strict params schema', () => {
    const strict = defineMinituiCatalog({
      id: 'strict',
      components: {
        Button: {
          props: z.object({ label: z.string() }).strict(),
          slots: [],
          description: 'btn',
          trustTier: 'interactive',
        },
      },
      actions: {
        tag: {
          params: z.object({ label: z.string() }).strict(),
          description: 'tag',
          kind: 'render-local',
        },
      },
    });
    const issues = checkSemantics(press('tag', { label: 'x', bogus: 1 }), strict, state);
    expect(messagesOf(issues, 'bad-params').some((m) => m.includes('"bogus"'))).toBe(true);
  });

  it('names a failing prop in the bad-props message', () => {
    const element = (props: Record<string, JsonValue>): AppSpec => ({
      root: 'b',
      elements: { b: { type: 'Button', props } },
    });
    const unknown = messagesOf(check(element({ label: 'Go', colour: 'red' })), 'bad-props');
    expect(unknown.some((m) => m.includes('colour'))).toBe(true);
    const mistyped = messagesOf(check(element({ label: 5 })), 'bad-props');
    expect(mistyped.some((m) => m.includes('label'))).toBe(true);
  });

  it('names each unresolved template pointer and the template in the bad-binding message', () => {
    const issues = checkSemantics(press('merge'), videoMergeCatalog, {
      inputs: [],
      codec: 'h264',
      output: '/abs/out.mp4',
    });
    const messages = messagesOf(issues, 'bad-binding');
    expect(messages.some((m) => m.includes('/inputs/0') && m.includes('/inputs/1'))).toBe(true);
    expect(messages.some((m) => m.includes('ffmpeg -i ${/inputs/0} -i ${/inputs/1}'))).toBe(true);
  });

  it('lists only the pointers that do not resolve', () => {
    const issues = checkSemantics(press('merge'), videoMergeCatalog, {
      inputs: ['/abs/a.mp4'],
      codec: 'h264',
      output: '/abs/out.mp4',
    });
    const message = messagesOf(issues, 'bad-binding').find((m) => m.startsWith('resourceTemplate'));
    expect(message).toContain('does not resolve against the bound state: /inputs/1.');
  });
});

describe('marker arms and typed values', () => {
  const state: JsonValue = { x: 'a', p: 'v', f: 'w', inputs: ['/abs/a.mp4', '/abs/b.mp4'] };
  const onProp = (value: JsonValue, element = 'Button', prop = 'label'): AppSpec => ({
    root: 'b',
    elements: { b: { type: element, props: { [prop]: value } } },
  });
  const onParam = (value: JsonValue): AppSpec => ({
    root: 'b',
    elements: {
      b: {
        type: 'Button',
        props: { label: 'Go' },
        on: { press: { action: 'setState', params: { statePath: value, value: 1 } } },
      },
    },
  });
  const issueCodes = (spec: AppSpec) => codes(checkSemantics(spec, videoMergeCatalog, state));

  it.each<[string, JsonValue]>([
    ['$path', { $path: '/x' }],
    ['$state null', { $state: null }],
    ['$state 0', { $state: 0 }],
    ['$state false', { $state: false }],
    ['$bindState null', { $bindState: null }],
  ])('refuses %s on a string prop as bad-props', (_name, value) => {
    expect(issueCodes(onProp(value))).toContain('bad-props');
  });

  it('does not call $path an off-grammar operator', () => {
    expect(issueCodes(onProp({ $path: '/x' }))).not.toContain('off-grammar-operator');
  });

  it('refuses $path on a typed param as bad-params', () => {
    expect(issueCodes(onParam({ $path: '/x' }))).toContain('bad-params');
  });

  it('accepts a typed array that holds a marker as a member', () => {
    expect(
      checkSemantics(
        onProp(['a', { $state: '/x' }], 'OrderList', 'items'),
        videoMergeCatalog,
        state,
      ),
    ).toEqual([]);
  });

  it('checks both pointers of one record against the state', () => {
    const issues = checkSemantics(
      onProp({ $state: '/p', $bindState: '/missing' }),
      videoMergeCatalog,
      state,
    );
    const dangling = issues.filter((i) => i.code === 'bad-binding');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.message).toContain('/missing');
  });

  it.each<[string, JsonValue]>([
    ['an empty $state', { $state: '' }],
    ['an empty $bindState', { $bindState: '' }],
  ])('refuses %s as bad-props on a prop and bad-params on a param', (_name, value) => {
    expect(issueCodes(onProp(value))).toContain('bad-props');
    expect(issueCodes(onParam(value))).toContain('bad-params');
  });

  it('names the prop or param that holds the empty pointer', () => {
    const prop = checkSemantics(onProp({ $state: '' }), videoMergeCatalog, state);
    expect(prop.some((i) => i.code === 'bad-props' && i.message.includes('"label"'))).toBe(true);
    const param = checkSemantics(onParam({ $state: '' }), videoMergeCatalog, state);
    expect(param.some((i) => i.code === 'bad-params' && i.message.includes('"statePath"'))).toBe(
      true,
    );
  });

  it('does not refuse an empty $item or $bindItem', () => {
    expect(issueCodes(onProp({ $bindItem: '' }))).not.toContain('bad-props');
    expect(issueCodes(onParam({ $item: '' }))).not.toContain('bad-params');
  });

  const ARMS: ReadonlyArray<readonly [string, JsonValue, JsonValue]> = [
    ['$state', 1, '/p'],
    ['$bindState', 1, '/p'],
    ['$item', 1, 'f'],
    ['$bindItem', 1, 'f'],
    ['$template', 1, 't'],
    ['$index', 'x', true],
  ];
  const computedSibling: JsonValue = { $computed: 'fn' };

  describe.each([
    ['the prop surface', (value: JsonValue) => onProp(value)],
    ['the param surface', (value: JsonValue) => onParam(value)],
  ])('%s', (_surface, build) => {
    it.each(ARMS)('a mistyped %s does not hide a live $computed sibling', (arm, mistyped) => {
      expect(issueCodes(build({ [arm]: mistyped, other: computedSibling }))).toContain(
        'off-grammar-operator',
      );
    });

    it.each(ARMS)('a well-typed %s makes its siblings dead', (arm, _mistyped, typed) => {
      expect(issueCodes(build({ [arm]: typed, other: computedSibling }))).not.toContain(
        'off-grammar-operator',
      );
    });

    it('an incomplete $cond does not hide a live $computed sibling', () => {
      expect(
        issueCodes(build({ $cond: { $state: '/p' }, $then: 'a', other: computedSibling })),
      ).toContain('off-grammar-operator');
    });

    it.each<[string, JsonValue]>([
      ['$state', { $state: '/p' }],
      ['$bindState', { $bindState: '/p' }],
      ['$path', { $path: '/p' }],
      ['$template', { $template: 't' }],
      ['$item', { $item: 'f' }],
      ['$index', { $index: true }],
      ['$bindItem', { $bindItem: 'f' }],
      ['a complete $cond', { $cond: { $state: '/p' }, $then: 'a', $else: 'b' }],
    ])('allows %s as an operator', (_name, value) => {
      expect(issueCodes(build(value))).not.toContain('off-grammar-operator');
    });
  });
});

describe('layout numbers are bounded', () => {
  const element = (type: string, props: Record<string, JsonValue>): AppSpec => ({
    root: 'b',
    elements: { b: { type, props } },
  });
  const check = (spec: AppSpec) => checkSemantics(spec, videoMergeCatalog, {});

  it.each<[string, AppSpec, string]>([
    ['Box marginTop 1001', element('Box', { marginTop: 1001 }), 'marginTop'],
    ['Box width -1001', element('Box', { width: -1001 }), 'width'],
    ['ProgressBar width -1001', element('ProgressBar', { progress: 0, width: -1001 }), 'width'],
  ])('refuses %s and names the prop', (_name, spec, prop) => {
    const issues = check(spec).filter((issue) => issue.code === 'bad-props');
    expect(issues.some((issue) => issue.message.includes(`"${prop}"`))).toBe(true);
  });

  it.each([
    ...['width', 'height', 'minWidth', 'minHeight'],
    ...[
      'padding',
      'paddingX',
      'paddingY',
      'paddingTop',
      'paddingBottom',
      'paddingLeft',
      'paddingRight',
    ],
    ...['margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight'],
    ...['gap', 'columnGap', 'rowGap'],
  ])('bounds %s', (prop) => {
    // the adopted schema bounds some of these on its own, so look for the gate's own message
    const issues = check(element('Box', { [prop]: 1001 }));
    expect(
      issues.some((i) => i.message.includes('layout bound') && i.message.includes(`"${prop}"`)),
    ).toBe(true);
  });

  it.each<[string, AppSpec]>([
    ['Box marginTop 1000', element('Box', { marginTop: 1000 })],
    ['Box width as a percentage', element('Box', { width: '50%' })],
    ['Box flexGrow above the bound', element('Box', { flexGrow: 5000 })],
    ['Box flexGrow 1', element('Box', { flexGrow: 1 })],
  ])('accepts %s', (_name, spec) => {
    expect(check(spec)).toEqual([]);
  });
});

describe('checkSemantics issue text is clean and bounded', () => {
  const ESC = '\u001b';
  const pointerSpec = (pointer: string, key = 'b'): AppSpec => ({
    root: key,
    elements: { [key]: { type: 'Button', props: { label: { $state: pointer } } } },
  });
  const run = (spec: AppSpec) => checkSemantics(spec, gateCatalog, {});

  it('returns no control byte for an unresolved pointer carrying escape sequences', () => {
    const issues = run(pointerSpec(`/${ESC}[31mred${ESC}]0;title\u0007`));
    expect(issues.some((i) => i.code === 'bad-binding')).toBe(true);
    for (const issue of issues) {
      expect(issue.message).not.toMatch(/\p{Cc}/u);
      expect(issue.elementKey).not.toMatch(/\p{Cc}/u);
    }
  });

  it('cuts a very long pointer and a very long element key', () => {
    const issues = run(pointerSpec(`/${'p'.repeat(100_000)}`, 'k'.repeat(100_000)));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(300);
      expect(issue.elementKey.length).toBeLessThanOrEqual(80);
    }
    expect(issues.some((i) => i.message.endsWith('…'))).toBe(true);
    expect(issues.some((i) => i.elementKey.endsWith('…'))).toBe(true);
  });

  it('returns a short pointer whole', () => {
    const [issue] = run(pointerSpec('/missing'));
    expect(issue?.message).toBe(
      'Prop binding "/missing" on "b" does not resolve against the bound state.',
    );
    expect(issue?.elementKey).toBe('b');
  });
});
