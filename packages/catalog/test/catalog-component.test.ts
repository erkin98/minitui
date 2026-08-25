import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineComponent,
  type MinituiComponentDef,
  type TrustTier,
} from '../src/contract/catalog-component.js';
import { isWiderThan, DEFAULT_VISIBILITY, SECRET_VISIBILITY } from '../src/contract/visibility.js';

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
    expect(def.trustTier).toBe('interactive');
    expect(def.slots).toEqual([]);
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
    expect(secretField.visibility).toBe('localOnly');
    expect(secretField.secret).toBe(true);
    expect(secretField.capturesText).toBe(true);
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
    expect(tiers).toHaveLength(2);
  });
});
