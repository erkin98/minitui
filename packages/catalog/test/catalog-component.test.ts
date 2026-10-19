import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineComponent,
  type MinituiComponentDef,
  type TrustTier,
} from '../src/contract/catalog-component.js';
import { isWiderThan, DEFAULT_VISIBILITY, SECRET_VISIBILITY } from '../src/contract/visibility.js';
import { defineMinituiCatalog } from '../src/define-catalog.js';

describe('VisibilityClass (field-visibility contract)', () => {
  it('defaults to the a2ui clientOnly class and pins localOnly for secrets', () => {
    expect(DEFAULT_VISIBILITY).toBe('clientOnly');
    expect(SECRET_VISIBILITY).toBe('localOnly');
  });
  it('isWiderThan is true only when requested is MORE exposed than declared', () => {
    expect(isWiderThan('remoteOnly', 'clientOnly')).toBe(true);
    expect(isWiderThan('remoteOnly', 'localOnly')).toBe(true);
    expect(isWiderThan('clientOnly', 'clientOnly')).toBe(false); // equal
    expect(isWiderThan('localOnly', 'remoteOnly')).toBe(false); // narrowing is allowed
  });
});

describe('MinituiComponentDef', () => {
  it('carries a trustTier alongside the json-render ComponentDefinition shape', () => {
    const def: MinituiComponentDef = {
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'A button',
      trustTier: 'interactive',
    };
    expect(defineComponent(def)).toBe(def);
    expect(def.props.safeParse({ label: 'Go' }).success).toBe(true);
  });

  it('carries an optional builder-owned visibility + secret + capturesText marker', () => {
    const secretField: MinituiComponentDef = {
      props: z.object({ token: z.string() }).strict(),
      slots: [],
      description: 'a secret token field',
      trustTier: 'interactive',
      visibility: 'localOnly',
      secret: true,
      capturesText: true, // a token field consumes typed characters — while focused it keeps `q` literal
    };
    expect(defineComponent(secretField)).toBe(secretField);
    expect(secretField.props.safeParse({ token: 'abc' }).success).toBe(true);
  });
  it('a .strict() props schema rejects unknown props', () => {
    const def = defineComponent({
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'x',
      trustTier: 'display',
    });
    expect(def.props.safeParse({ label: 'Go', evil: 1 }).success).toBe(false);
  });
  it('TrustTier is the closed display|interactive union', () => {
    const tiers: TrustTier[] = ['display', 'interactive'];
    for (const trustTier of tiers) {
      const catalog = defineMinituiCatalog({
        id: 'tiers',
        components: { C: { props: z.object({}).strict(), slots: [], description: 'c', trustTier } },
        actions: {},
      });
      expect(catalog.tierOf('C')).toBe(trustTier);
    }
  });
});
