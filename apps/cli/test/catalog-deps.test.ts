import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { videoMergeCatalog } from '@minitui/catalog';
import { checkActionParams, hostCatalogDeps } from '../src/catalog-deps.js';

const catalog = {
  actionDefs: new Map<string, { readonly params: z.ZodType }>([
    ['merge', { params: z.object({ inputs: z.array(z.string()), output: z.string() }) }],
    ['loose', { params: z.record(z.string(), z.string()) }],
  ]),
};

describe('checkActionParams', () => {
  it('accepts params the action schema accepts', () => {
    expect(checkActionParams(catalog, 'merge', { inputs: ['a'], output: 'o' })).toBe(true);
  });

  it('refuses a key outside the schema, which a plain parse would strip and let through', () => {
    const params = { inputs: ['a'], output: 'o', mode: 'copy' };
    expect(catalog.actionDefs.get('merge')?.params.safeParse(params).success).toBe(true);
    expect(checkActionParams(catalog, 'merge', params)).toBe(false);
  });

  it('refuses a key named like a member of Object.prototype', () => {
    expect(checkActionParams(catalog, 'merge', { inputs: [], output: 'o', constructor: 1 })).toBe(
      false,
    );
  });

  it('refuses params the schema rejects', () => {
    expect(checkActionParams(catalog, 'merge', { inputs: 'a', output: 'o' })).toBe(false);
    expect(checkActionParams(catalog, 'merge', { inputs: ['a'] })).toBe(false);
  });

  it('refuses an action the catalog does not have', () => {
    expect(checkActionParams(catalog, 'missing', {})).toBe(false);
  });

  it('refuses an action whose schema is not an object, since its keys cannot be checked', () => {
    expect(checkActionParams(catalog, 'loose', { anything: 'goes' })).toBe(false);
  });
});

describe('checkActionParams against the real merge action', () => {
  const params = { inputs: ['/abs/a.mp4', '/abs/b.mp4'], codec: 'h264', output: '/abs/out.mp4' };

  it('accepts the three parameters of the action', () => {
    expect(checkActionParams(videoMergeCatalog, 'merge', params)).toBe(true);
  });

  it('refuses the mode that a renderer could add', () => {
    expect(checkActionParams(videoMergeCatalog, 'merge', { ...params, mode: 'copy' })).toBe(false);
  });
});

describe('hostCatalogDeps', () => {
  const deps = hostCatalogDeps(videoMergeCatalog);

  it('answers from the catalog, not from the caller', () => {
    expect(deps.kindOf('merge')).toBe('exec-local');
    expect(deps.callableFromOf('merge')).toBe('clientOnly');
    expect(deps.permissionOf('merge')?.danger).toBe(true);
  });

  it('knows nothing about an unknown action', () => {
    expect(deps.kindOf('nope')).toBeUndefined();
    expect(deps.callableFromOf('nope')).toBeUndefined();
    expect(deps.permissionOf('nope')).toBeUndefined();
  });

  it('checks params with the strict rule', () => {
    expect(
      deps.checkParams('merge', { inputs: ['/a', '/b'], codec: 'h264', output: '/o', mode: 'x' }),
    ).toBe(false);
  });
});
