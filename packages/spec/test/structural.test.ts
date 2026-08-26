import { describe, it, expect } from 'vitest';
import type { MiniAppSpec } from '../src/spec-types.js';
import { validateStructure, autoFixStructure, MAX_RETRIES } from '../src/structural.js';
import { ActionKindSchema, ACTION_KINDS } from '../src/catalog-action.js';
import * as spec from '../src/index.js';

describe('spec-types', () => {
  it('MiniAppSpec carries a required state object and optional meta', () => {
    const spec: MiniAppSpec = {
      root: 'r',
      elements: { r: { type: 'Box', props: {} } },
      state: { codec: 'h264' },
      meta: { catalogId: 'video-merge', schemaVersion: 1 },
    };
    expect(spec.state.codec).toBe('h264');
    expect(spec.meta?.schemaVersion).toBe(1);
  });
});

describe('catalog-action', () => {
  it('parses the four canonical kebab-case kinds and rejects unknown', () => {
    expect(ActionKindSchema.parse('exec-local')).toBe('exec-local');
    expect(ActionKindSchema.parse('agent-callback')).toBe('agent-callback');
    expect(() => ActionKindSchema.parse('execLocal')).toThrow();
    expect(() => ActionKindSchema.parse('delete')).toThrow();
  });

  it('surfaces the canonical ACTION_KINDS list (no camelCase fork)', () => {
    expect([...ACTION_KINDS]).toEqual(['render-local', 'exec-local', 'exec-mcp', 'agent-callback']);
  });
});

describe('structural', () => {
  it('MAX_RETRIES is 5 (the adopted maxRetries ceiling)', () => {
    expect(MAX_RETRIES).toBe(5);
  });

  it('flags a missing root', () => {
    // A plain Spec value — no cast needed: root/elements are the only required
    // fields, and the validator's job is to catch the SEMANTICALLY empty root.
    const r = validateStructure({ root: '', elements: {} });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_root')).toBe(true);
  });

  it('autoFix moves a misplaced `visible` out of props and returns a fresh spec', () => {
    // Also a plain Spec: UIElement.props is Record<string, unknown>, so the
    // misplaced `visible` typechecks — the autofixer's job is to relocate it.
    const input = {
      root: 'a',
      elements: { a: { type: 'Box', props: { visible: { eq: 1 } } } },
    };
    const out = autoFixStructure(input);
    expect(out.fixes.length).toBeGreaterThan(0);
    expect(out.spec).not.toBe(input); // immutability: new object
  });
});

describe('barrel', () => {
  it('exports the cross-package public surface', () => {
    expect(typeof spec.composeValidation).toBe('function');
    expect(typeof spec.toWireSpec).toBe('function');
    expect(typeof spec.buildValidationEnvelope).toBe('function');
    expect(typeof spec.compileSpecStream).toBe('function');
    expect(typeof spec.collectBoundPointers).toBe('function');
    expect(spec.MAX_RETRIES).toBe(5);
  });
});
