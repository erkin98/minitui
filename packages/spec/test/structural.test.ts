import { describe, it, expect } from 'vitest';
import type { MiniAppSpec, Spec } from '../src/spec-types.js';
import {
  validateStructure,
  validateConditions,
  autoFixStructure,
  MAX_RETRIES,
} from '../src/structural.js';
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

  it('never silently prunes a dangling child ref — a typo stays a surfaced error', () => {
    // `children` names `body` but only `bdy` (typo) is defined. The autofixer must
    // not quietly drop `body`; the defect has to survive so the structural validator
    // reports it and the loop reprompts instead of shipping a spec missing an element.
    const input = {
      root: 'root',
      elements: {
        root: { type: 'Box', props: {}, children: ['header', 'body'] },
        header: { type: 'Box', props: {} },
        bdy: { type: 'Box', props: {} },
      },
    };
    const out = autoFixStructure(input);
    expect(out.spec.elements.root?.children).toContain('body');
    const v = validateStructure(input);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.code === 'missing_child')).toBe(true);
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

describe('validateConditions', () => {
  const specOf = (elementJson: string): Spec => {
    const built: Spec = JSON.parse(`{"root":"r","elements":{"r":${elementJson}},"state":{}}`);
    return built;
  };
  const wrap = (condition: string) => ({
    visible: `{"type":"Box","props":{},"visible":${condition}}`,
    prop: `{"type":"Text","props":{"text":{"$cond":${condition},"$then":"a","$else":"b"}}}`,
    param: `{"type":"Button","props":{},"on":{"press":{"action":"go","params":{"v":{"$cond":${condition},"$then":1,"$else":2}}}}}`,
    list: `{"type":"Button","props":{},"on":{"press":[{"action":"go"},{"action":"go","params":{"v":{"$cond":${condition},"$then":1,"$else":2}}}]}}`,
    watch: `{"type":"Box","props":{},"watch":{"/codec":{"action":"go","params":{"v":{"$cond":${condition},"$then":1,"$else":2}}}}}`,
    nested: `{"type":"Select","props":{"options":[{"label":{"$cond":${condition},"$then":"a","$else":"b"},"value":"x"}]}}`,
  });

  const bad = ['null', '[null]', '{"$and":1}', '5', '"true"', '{"$state":5}', '{"$or":[{}]}', '{}'];

  it.each(bad)('a bad condition %s is one issue wherever a condition sits', (condition) => {
    const sites = wrap(condition);
    const places =
      condition === '{}'
        ? Object.entries(sites).filter(([k]) => k !== 'visible')
        : Object.entries(sites);
    for (const [place, element] of places) {
      const issues = validateConditions(specOf(element));
      expect(issues, place).toHaveLength(1);
      expect(issues[0]?.code, place).toBe('empty_spec');
      expect(issues[0]?.severity, place).toBe('error');
    }
  });

  it('{} as the visible value is refused too', () => {
    expect(validateConditions(specOf(wrap('{}').visible))).toHaveLength(1);
  });

  const good = [
    'true',
    'false',
    '{"$state":"/codec"}',
    '{"$state":"/codec","eq":"h264"}',
    '{"$state":"/output","not":true}',
    '[{"$state":"/codec"},{"$state":"/output"}]',
    '{"$and":[{"$state":"/codec"},true]}',
    '{"$or":[{"$state":"/codec"},{"$state":"/later/key"}]}',
    '{"$item":"done"}',
    '{"$index":true,"gt":0}',
    '{"$state":"/merge/progress","gte":{"$state":"/merge/progress"}}',
  ];

  it.each(good)('the taught condition %s passes everywhere', (condition) => {
    for (const [place, element] of Object.entries(wrap(condition))) {
      expect(validateConditions(specOf(element)), place).toEqual([]);
    }
  });

  it('a visible condition pointing at a key that state does not hold yet passes', () => {
    expect(validateConditions(specOf(wrap('{"$state":"/later/key"}').visible))).toEqual([]);
  });

  it('a taught $cond with a template branch passes', () => {
    const element =
      '{"type":"Text","props":{"text":{"$cond":{"$state":"/ready"},"$then":"yes","$else":{"$template":"waiting ${/n}"}}}}';
    expect(validateConditions(specOf(element))).toEqual([]);
  });

  it('a record with $cond but no $then and $else is not a complete $cond and is not judged', () => {
    expect(validateConditions(specOf('{"type":"Text","props":{"text":{"$cond":5}}}'))).toEqual([]);
  });

  it('an element without a visible key is not judged', () => {
    expect(validateConditions(specOf('{"type":"Box","props":{}}'))).toEqual([]);
  });

  it('the message is fixed and carries nothing the model wrote', () => {
    const issues = validateConditions(
      specOf('{"type":"Box","props":{},"visible":{"$and":"PRIVATE-CONDITION-TEXT"}}'),
    );
    expect(issues[0]?.message).toContain('condition');
    expect(issues[0]?.message).not.toContain('PRIVATE-CONDITION-TEXT');
  });
});

describe('autoFixStructure: a key at both levels', () => {
  const both = (key: string, value: string): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"r","elements":{"r":{"type":"Box","props":{"${key}":${value}},"${key}":${value}}},"state":{}}`,
    );
    return built;
  };
  const only = (key: string, value: string): Spec => {
    const built: Spec = JSON.parse(
      `{"root":"r","elements":{"r":{"type":"Box","props":{"${key}":${value}}}},"state":{}}`,
    );
    return built;
  };
  const keys: Array<[string, string]> = [
    ['visible', 'true'],
    ['on', '{"press":{"action":"x"}}'],
    ['repeat', '{"statePath":"/rows"}'],
    ['watch', '{"/a":{"action":"x"}}'],
  ];

  it.each(keys)('%s at both levels: the spec comes back unchanged with no fixes', (key, value) => {
    const input = both(key, value);
    const result = autoFixStructure(input);
    expect(result.spec).toBe(input);
    expect(result.fixes).toEqual([]);
  });

  it.each(keys)('%s only in props is still relocated', (key, value) => {
    const result = autoFixStructure(only(key, value));
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.spec.elements.r).toHaveProperty(key);
  });
});
