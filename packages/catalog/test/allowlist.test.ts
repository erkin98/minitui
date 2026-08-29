import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '../src/define-catalog.js';
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

  it('a null/absent event group has no bindings to gather — returns []', () => {
    const spec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'app',
        elements: { app: { type: 'Box', props: {}, on: null } },
      }),
    );
    expect(rejectOffCatalog(spec, cat)).toEqual([]);
  });
});

describe('throwingFallback (render-time gate)', () => {
  it('throws loud naming the off-catalog type — never a silent no-op', () => {
    expect(() => throwingFallback('IFrame')).toThrowError(/IFrame/);
  });
});
