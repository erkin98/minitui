import { describe, it, expect } from 'vitest';
import {
  ActionBindingSchema,
  SpecElementSchema,
  AppSpecSchema,
  type AppSpec,
} from '../src/spec.js';

const sample: AppSpec = {
  root: 'app',
  elements: {
    app: { type: 'Box', props: {}, children: ['picker', 'merge'] },
    picker: { type: 'FilePicker', props: { value: { $bindState: '/inputs' }, label: 'Input' } },
    merge: {
      type: 'Button',
      props: { label: 'Merge' },
      on: { press: { action: 'merge', params: { codec: 'h264' } } },
    },
  },
};

describe('AppSpec', () => {
  it('parses a flat element map with a root and children-by-key (state-free — the data model rides MiniAppSpec)', () => {
    expect(AppSpecSchema.parse(sample)).toEqual(sample);
  });
  it('requires a root key', () => {
    const { root: _omit, ...noRoot } = sample;
    expect(AppSpecSchema.safeParse(noRoot).success).toBe(false);
  });
  it('carries on-bindings through parse intact (nothing stripped)', () => {
    const el = SpecElementSchema.parse(sample.elements.merge);
    expect(el.on?.press).toEqual({ action: 'merge', params: { codec: 'h264' } });
  });
  it('rejects binding grammar outside the gated subset (spec-supplied confirm/chains)', () => {
    expect(
      ActionBindingSchema.safeParse({ action: 'merge', confirm: { title: 'x', message: 'y' } })
        .success,
    ).toBe(false);
    expect(
      ActionBindingSchema.safeParse({ action: 'merge', onSuccess: { action: 'chain' } }).success,
    ).toBe(false);
  });
  it('rejects an element whose props value is undefined', () => {
    expect(SpecElementSchema.safeParse({ type: 'T', props: { a: undefined } }).success).toBe(false);
  });
  it('strips an unknown top-level key from AppSpec and SpecElement (§Z105 strip-by-design, C15)', () => {
    const spec = AppSpecSchema.parse({
      root: 'a',
      elements: { a: { type: 'Box', props: {} } },
      hax: 1,
    });
    expect('hax' in spec).toBe(false);
    const el = SpecElementSchema.parse({ type: 'T', props: {}, hax: 1 });
    expect('hax' in el).toBe(false);
  });
});

describe('dynamic-key containers reject reserved keys (ledger §Z100 AMEND)', () => {
  const reserved = ['__proto__', 'constructor', 'prototype'];
  it('ActionBinding.params rejects a reserved param key and names it in issue.path', () => {
    for (const k of reserved) {
      const r = ActionBindingSchema.safeParse(
        JSON.parse(`{"action":"merge","params":{${JSON.stringify(k)}:1}}`),
      );
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.includes(k))).toBe(true);
    }
    expect(
      ActionBindingSchema.safeParse({ action: 'merge', params: { codec: 'h264' } }).success,
    ).toBe(true);
  });
  it('SpecElement.props rejects a reserved prop key, including a NON-enumerable own key', () => {
    for (const k of reserved) {
      const r = SpecElementSchema.safeParse(
        JSON.parse(`{"type":"T","props":{${JSON.stringify(k)}:1}}`),
      );
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.includes(k))).toBe(true);
    }
    const props: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(props, 'constructor', {
      value: 1,
      enumerable: false,
      configurable: true,
    });
    expect(SpecElementSchema.safeParse({ type: 'T', props }).success).toBe(false);
    expect(SpecElementSchema.safeParse({ type: 'T', props: { label: 'ok' } }).success).toBe(true);
  });
  it('AppSpec.elements rejects a reserved element key and names it in issue.path', () => {
    for (const k of reserved) {
      const r = AppSpecSchema.safeParse(
        JSON.parse(
          `{"root":"a","elements":{"a":{"type":"Box","props":{}},${JSON.stringify(k)}:{"type":"Box","props":{}}}}`,
        ),
      );
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.includes(k))).toBe(true);
    }
    expect(
      AppSpecSchema.safeParse({ root: 'a', elements: { a: { type: 'Box', props: {} } } }).success,
    ).toBe(true);
  });
  it('SpecElement.on and .watch reject a reserved binding key (same guardedRecord factory, C15)', () => {
    for (const field of ['on', 'watch']) {
      for (const k of reserved) {
        const r = SpecElementSchema.safeParse(
          JSON.parse(`{"type":"T","props":{},"${field}":{${JSON.stringify(k)}:{"action":"x"}}}`),
        );
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues.some((i) => i.path.includes(k))).toBe(true);
      }
    }
    // Positive control: a legit event/watch key is accepted (no over-rejection).
    expect(
      SpecElementSchema.safeParse({ type: 'T', props: {}, on: { press: { action: 'x' } } }).success,
    ).toBe(true);
    expect(
      SpecElementSchema.safeParse({ type: 'T', props: {}, watch: { '/s': { action: 'x' } } })
        .success,
    ).toBe(true);
  });
});

// PIN-C14 (fold): the guarded dynamic containers are shallow-READONLY — the
// `guardedRecord(...).readonly()` shape (pointer.ts) freezes the top container,
// consistent with the codebase's immutability principle. Lock Object.isFrozen so
// dropping `.readonly()` reds this gate (C14 decision, ratified in the ledger).
describe('dynamic-key containers are shallow-frozen (PIN-C14)', () => {
  it('ActionBinding.params / SpecElement.props / AppSpec.elements parse to frozen containers', () => {
    expect(
      Object.isFrozen(ActionBindingSchema.parse({ action: 'm', params: { codec: 'h264' } }).params),
    ).toBe(true);
    expect(
      Object.isFrozen(SpecElementSchema.parse({ type: 'T', props: { label: 'ok' } }).props),
    ).toBe(true);
    expect(
      Object.isFrozen(
        AppSpecSchema.parse({ root: 'a', elements: { a: { type: 'Box', props: {} } } }).elements,
      ),
    ).toBe(true);
  });
});
