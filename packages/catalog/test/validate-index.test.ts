import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '../src/define-catalog.js';
import { runFullValidation } from '../src/validate/index.js';
import { CATALOG_REPAIR_WORDING } from '../src/validate/runtime.js';
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
  },
});

describe('runFullValidation', () => {
  it('returns ok for a clean spec', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },
      },
    };
    expect(runFullValidation(spec, cat, { inputs: ['/abs/a.mp4'] })).toEqual({ ok: true });
  });

  it('short-circuits on an allowlist issue before semantic checks', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: { b: { type: 'IFrame', props: { evil: 1 } } },
    };
    const r = runFullValidation(spec, cat, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // only the allowlist issue, NOT a downstream bad-props on the unknown type
      expect(r.issues.every((i) => 'offending' in i)).toBe(true);
    }
  });

  it('reports semantic issues when the spec is on-catalog but unsound', () => {
    const spec: AppSpec = {
      root: 'b',
      elements: {
        b: { type: 'Button', props: { label: 'Go' }, on: { press: { action: 'merge' } } },
      },
    };
    const r = runFullValidation(spec, cat, { inputs: [] }); // /inputs/0 missing -> bad-binding
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => 'code' in i && i.code === 'bad-binding')).toBe(true);
  });
});

describe('CATALOG_REPAIR_WORDING', () => {
  it("is a domain-hint string spec's toRuntimeRepair appends (not a fault->prompt builder)", () => {
    expect(typeof CATALOG_REPAIR_WORDING).toBe('string');
    expect(CATALOG_REPAIR_WORDING).toMatch(/codec|path|parameter/i);
  });
});
