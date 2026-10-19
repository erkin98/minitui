import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog, type MinituiCatalog } from '../src/define-catalog.js';
import { MALFORMED_CASES, cleanSpec, gateCatalog, unicodeKeySpec } from './malformed-specs.js';
import { rejectOffCatalog, throwingFallback, type AllowlistIssue } from '../src/allowlist.js';
import type { AppSpec } from '../src/contract/spec.js';

const cat = defineMinituiCatalog({
  id: 'demo',
  components: {
    Box: {
      props: z.object({}).strict(),
      slots: ['default'],
      description: 'box',
      trustTier: 'display',
    },
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
      permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'Merge' },
    },
    // std name registered explicitly — the gate has no implicit std union.
    setState: {
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'set',
      kind: 'render-local',
    },
  },
});

describe('rejectOffCatalog (generation-time gate)', () => {
  it('passes a fully on-catalog spec (actions bound under on[event])', () => {
    const spec: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Box', props: {}, children: ['b'] },
        b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },
      },
    };
    expect(rejectOffCatalog(spec, cat)).toEqual([]);
  });

  it('rejects an unknown component type', () => {
    const spec: AppSpec = {
      root: 'app',
      elements: { app: { type: 'IFrame', props: {} } },
    };
    const issues = rejectOffCatalog(spec, cat);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unknown-component');
    expect(issues[0]?.offending).toBe('IFrame');
  });

  it('rejects an unknown ACTION bound under on[event] (the core validator has no action grammar)', () => {
    const spec: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Button', props: { label: 'X' }, on: { press: { action: 'exfiltrate' } } },
      },
    };
    const issues = rejectOffCatalog(spec, cat);
    expect(issues.map((i: AllowlistIssue) => i.code)).toContain('unknown-action');
  });

  it('rejects an unknown action bound under watch (state watchers dispatch too)', () => {
    const spec: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Box', props: {}, watch: { '/inputs': [{ action: 'exfiltrate' }] } },
      },
    };
    expect(rejectOffCatalog(spec, cat).map((i) => i.offending)).toContain('exfiltrate');
  });

  it('accepts a REGISTERED std action (setState) but rejects an UNREGISTERED std name (exit)', () => {
    const ok: AppSpec = {
      root: 'app',
      elements: {
        app: {
          type: 'Button',
          props: { label: 'X' },
          on: { press: { action: 'setState', params: { statePath: '/x', value: 1 } } },
        },
      },
    };
    expect(rejectOffCatalog(ok, cat)).toEqual([]);

    const bad: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Button', props: { label: 'X' }, on: { press: { action: 'exit' } } },
      },
    };
    expect(rejectOffCatalog(bad, cat).map((i) => i.offending)).toContain('exit');
  });

  it('rejects an onSuccess/onError callback — off the frozen action grammar', () => {
    // A model-authored spec carrying an off-grammar onSuccess: json-render would
    // EXECUTE its ungated set write + chained action. The wire ActionBinding type
    // omits the field, so parse a JSON literal into the typed spec (no cast — the
    // sanctioned invalid-input recipe) to mirror the untrusted model stream.
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: {
          app: {
            type: 'Button',
            props: { label: 'X' },
            on: { press: { action: 'merge', onSuccess: { set: { '/pwned': true } } } },
          },
        },
      }),
    );
    expect(rejectOffCatalog(spec, cat).map((i) => i.code)).toContain('off-grammar-callback');
  });

  it('rejects an onError callback on its own', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: {
          app: {
            type: 'Button',
            props: { label: 'X' },
            on: { press: { action: 'merge', onError: { set: { '/pwned': true } } } },
          },
        },
      }),
    );
    const issues = rejectOffCatalog(spec, cat);
    expect(issues.map((i) => i.code)).toContain('off-grammar-callback');
    expect(issues.map((i) => i.offending)).toContain('onError');
  });

  it('rejects an agent-authored confirm dialog — consent is host-resolved, not spec-authored', () => {
    // json-render resolveActionBinding reads binding.confirm and would surface
    // spec-authored consent text. The wire ActionBinding type omits it, so parse a
    // JSON literal into the typed spec (the sanctioned invalid-input recipe).
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: {
          app: {
            type: 'Button',
            props: { label: 'X' },
            on: { press: { action: 'merge', confirm: { title: 'Delete?', message: 'sure?' } } },
          },
        },
      }),
    );
    const issues = rejectOffCatalog(spec, cat);
    expect(issues.map((i: AllowlistIssue) => i.code)).toContain('off-grammar-callback');
    expect(issues.map((i: AllowlistIssue) => i.offending)).toContain('confirm');
  });

  it('rejects a preventDefault flag on a binding — off the frozen action grammar', () => {
    // The wire ActionBinding is action + params only; the pinned json-render binding
    // carries a 4th preventDefault field (a browser-navigation flag, inert in a TUI).
    // Parse a JSON literal into the typed spec (the sanctioned invalid-input recipe,
    // no cast) to mirror an untrusted model stream that rides the excess key through.
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: {
          app: {
            type: 'Button',
            props: { label: 'X' },
            on: { press: { action: 'merge', preventDefault: true } },
          },
        },
      }),
    );
    const issues = rejectOffCatalog(spec, cat);
    expect(issues.map((i: AllowlistIssue) => i.code)).toContain('off-grammar-callback');
    expect(issues.map((i: AllowlistIssue) => i.offending)).toContain('preventDefault');

    // Control: the same binding without preventDefault raises no off-grammar issue,
    // isolating preventDefault as the trigger (not the merge action itself).
    const clean: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Button', props: { label: 'X' }, on: { press: { action: 'merge' } } },
      },
    };
    expect(rejectOffCatalog(clean, cat).map((i: AllowlistIssue) => i.code)).not.toContain(
      'off-grammar-callback',
    );
  });

  it('rejects a null binding VALUE as malformed-binding — returns an issue, never throws', () => {
    // json-render validateSpec never validates binding VALUES, so a null binding
    // reaches this walk. It must fail closed with a repromptable issue, not crash
    // the no-throw gate with a TypeError.
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: { app: { type: 'Button', props: { label: 'X' }, on: { press: null } } },
      }),
    );
    expect(() => rejectOffCatalog(spec, cat)).not.toThrow();
    expect(rejectOffCatalog(spec, cat).map((i: AllowlistIssue) => i.code)).toContain(
      'malformed-binding',
    );
  });

  it('rejects a null entry inside a binding array as malformed-binding', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: { app: { type: 'Button', props: { label: 'X' }, on: { press: [null] } } },
      }),
    );
    expect(rejectOffCatalog(spec, cat).map((i: AllowlistIssue) => i.code)).toContain(
      'malformed-binding',
    );
  });

  it('an absent event group has no bindings to gather — returns []', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({ root: 'app', elements: { app: { type: 'Box', props: {} } } }),
    );
    expect(rejectOffCatalog(spec, cat)).toEqual([]);
  });

  it.each(['on', 'watch'])('a null %s is one malformed-binding issue', (field) => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: { app: { type: 'Box', props: {}, [field]: null } },
      }),
    );
    expect(rejectOffCatalog(spec, cat).map((i: AllowlistIssue) => i.code)).toEqual([
      'malformed-binding',
    ]);
  });
});

describe('throwingFallback (render-time gate)', () => {
  it('throws loud naming the off-catalog type — never a silent no-op', () => {
    expect(() => throwingFallback('IFrame')).toThrowError(/IFrame/);
  });
});

describe('rejectOffCatalog answers a malformed spec with an issue', () => {
  it.each(MALFORMED_CASES)('$name', ({ build, code, messagePart }) => {
    const issues: readonly AllowlistIssue[] = Reflect.apply(rejectOffCatalog, undefined, [
      build(),
      gateCatalog,
    ]);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain(code);
    expect(codes).not.toContain('gate-internal-error');
    if (messagePart !== undefined) {
      expect(issues.some((issue) => issue.message.includes(messagePart))).toBe(true);
    }
  });

  it('returns no issue for a spec whose element keys are not ASCII', () => {
    const issues: readonly AllowlistIssue[] = Reflect.apply(rejectOffCatalog, undefined, [
      unicodeKeySpec,
      gateCatalog,
    ]);
    expect(issues).toEqual([]);
  });

  it('still returns no issue for a plain valid spec', () => {
    const issues: readonly AllowlistIssue[] = Reflect.apply(rejectOffCatalog, undefined, [
      cleanSpec,
      gateCatalog,
    ]);
    expect(issues).toEqual([]);
  });

  it('returns one gate-internal-error issue when the walk itself throws', () => {
    const faulty: MinituiCatalog = Object.defineProperty({ ...gateCatalog }, 'componentNames', {
      get(): never {
        throw new Error('catalog fault');
      },
    });
    const issues: readonly AllowlistIssue[] = Reflect.apply(rejectOffCatalog, undefined, [
      cleanSpec,
      faulty,
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(['gate-internal-error']);
  });
});

describe('rejectOffCatalog refuses watch', () => {
  const issuesFor = (watch: unknown): readonly AllowlistIssue[] => {
    const spec: unknown = { root: 'app', elements: { app: { type: 'Box', props: {}, watch } } };
    return Reflect.apply(rejectOffCatalog, undefined, [spec, cat]);
  };

  it.each([
    [
      'an on-catalog action',
      { '/x': { action: 'setState', params: { statePath: '/y', value: 1 } } },
    ],
    ['the dangerous action', { '/x': { action: 'merge' } }],
    ['an empty map', {}],
  ])('refuses %s under watch', (_name, watch) => {
    expect(issuesFor(watch).map((issue) => issue.code)).toContain('watch-unsupported');
  });

  it('names the element and tells the model to bind under on', () => {
    const issue = issuesFor({ '/x': { action: 'merge' } }).find(
      (i) => i.code === 'watch-unsupported',
    );
    expect(issue?.elementKey).toBe('app');
    expect(issue?.offending).toBe('watch');
    expect(issue?.message).toContain('not supported');
    expect(issue?.message).toContain('`on`');
  });

  it('still names an off-catalog action under watch', () => {
    const issues = issuesFor({ '/x': { action: 'exfiltrate' } });
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unknown-action', 'watch-unsupported']),
    );
    expect(issues.map((issue) => issue.offending)).toContain('exfiltrate');
  });

  it('answers a null watch with the shape issue, not the watch refusal', () => {
    const codes = issuesFor(null).map((issue) => issue.code);
    expect(codes).toContain('malformed-binding');
    expect(codes).not.toContain('watch-unsupported');
  });

  it('accepts the same binding under on', () => {
    const spec: AppSpec = {
      root: 'app',
      elements: {
        app: { type: 'Button', props: { label: 'X' }, on: { press: { action: 'merge' } } },
      },
    };
    expect(rejectOffCatalog(spec, cat)).toEqual([]);
  });
});

describe('rejectOffCatalog allows only action and params on a binding', () => {
  const bindingWith = (extra: Record<string, unknown>): AppSpec =>
    JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: {
          app: {
            type: 'Button',
            props: { label: 'X' },
            on: { press: { action: 'merge', ...extra } },
          },
        },
      }),
    );

  it.each([
    ['onSuccess', { set: { '/x': 1 } }],
    ['onError', { set: { '/x': 1 } }],
    ['confirm', { title: 'Sure?' }],
    ['preventDefault', true],
    ['callableFrom', 'remoteOnly'],
    ['callableFrom', 'clientOnly'],
    ['somethingElse', 1],
  ])('refuses %s and names it', (field, value) => {
    const issues = rejectOffCatalog(bindingWith({ [field]: value }), cat);
    expect(issues.some((i) => i.code === 'off-grammar-callback' && i.offending === field)).toBe(
      true,
    );
  });

  it('passes a binding with action and params alone', () => {
    expect(rejectOffCatalog(bindingWith({ params: {} }), cat)).toEqual([]);
  });
});

describe('rejectOffCatalog issue text is clean and bounded', () => {
  const ESC = '\u001b';
  const hasLoneSurrogate = (text: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  const onCatalogButton = (action: string): AppSpec => ({
    root: 'a',
    elements: { a: { type: 'Button', props: { label: 'X' }, on: { press: { action } } } },
  });
  const typed = (type: string, key = 'a'): AppSpec => ({
    root: key,
    elements: { [key]: { type, props: {} } },
  });
  const run = (spec: AppSpec) => rejectOffCatalog(spec, gateCatalog);
  const fields = (issues: readonly AllowlistIssue[]) =>
    issues.flatMap((i) => [i.message, i.elementKey, i.offending]);

  it('returns no control byte for an off-catalog type or action carrying escape sequences', () => {
    const dirty = `${ESC}[31mred${ESC}]0;title\u0007`;
    for (const issues of [run(typed(dirty)), run(onCatalogButton(dirty))]) {
      expect(issues.length).toBeGreaterThan(0);
      for (const text of fields(issues)) expect(text).not.toMatch(/\p{Cc}/u);
    }
  });

  it('cuts a very long type, action and element key', () => {
    const long = 'x'.repeat(100_000);
    for (const issues of [run(typed(long)), run(onCatalogButton(long)), run(typed('Nope', long))]) {
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.message.length).toBeLessThanOrEqual(300);
        expect(issue.elementKey.length).toBeLessThanOrEqual(80);
        expect(issue.offending.length).toBeLessThanOrEqual(80);
      }
    }
    const [issue] = run(typed(long));
    expect(issue?.message.endsWith('…')).toBe(true);
    expect(issue?.offending.endsWith('…')).toBe(true);
    expect(run(typed('Nope', long))[0]?.elementKey.endsWith('…')).toBe(true);
  });

  it('returns a short name whole', () => {
    const [issue] = run(typed('Nope'));
    expect(issue?.offending).toBe('Nope');
    expect(issue?.elementKey).toBe('a');
    expect(issue?.message).toBe('Component "Nope" is not in catalog "demo".');
  });

  it('keeps a message of exactly 300 code units and cuts one of 301', () => {
    const fixed = 'Component "" is not in catalog "demo".'.length;
    const at = run(typed('x'.repeat(300 - fixed)))[0];
    expect(at?.message).toHaveLength(300);
    expect(at?.message.endsWith('…')).toBe(false);
    const over = run(typed('x'.repeat(301 - fixed)))[0];
    expect(over?.message).toHaveLength(300);
    expect(over?.message.endsWith('…')).toBe(true);
  });

  it('keeps an element key and an offending name of exactly 80 code units and cuts 81', () => {
    const at = run(typed('t'.repeat(80), 'k'.repeat(80)))[0];
    expect(at?.offending).toBe('t'.repeat(80));
    expect(at?.elementKey).toBe('k'.repeat(80));
    const over = run(typed('t'.repeat(81), 'k'.repeat(81)))[0];
    expect(over?.offending).toBe(`${'t'.repeat(79)}…`);
    expect(over?.elementKey).toBe(`${'k'.repeat(79)}…`);
  });

  it('does not leave half of a surrogate pair at the cut', () => {
    const issue = run(typed('😀'.repeat(50_000)))[0];
    expect(hasLoneSurrogate(issue?.offending ?? '')).toBe(false);
    expect(hasLoneSurrogate(issue?.message ?? '')).toBe(false);
    expect(issue?.offending.length).toBeLessThanOrEqual(80);
  });
});
