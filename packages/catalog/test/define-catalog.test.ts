import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '../src/define-catalog.js';

const cat = defineMinituiCatalog({
  id: 'demo',
  components: {
    Button: {
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'btn',
      trustTier: 'interactive',
    },
    // std prop name is `progress` (adopt-verbatim from @json-render/ink)
    ProgressBar: {
      props: z.object({ progress: z.number() }).strict(),
      slots: [],
      description: 'pb',
      trustTier: 'display',
    },
  },
  actions: {
    go: {
      params: z.object({}),
      description: 'run it',
      kind: 'exec-local',
      permission: { danger: true, resourceTemplate: 'echo hi', summaryTemplate: 'Say hi' },
    },
    setState: {
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'set',
      kind: 'render-local',
    },
  },
});

describe('defineMinituiCatalog', () => {
  it('exposes component + action names from the adopted base catalog', () => {
    expect([...cat.componentNames].sort()).toEqual(['Button', 'ProgressBar']);
    expect([...cat.actionNames].sort()).toEqual(['go', 'setState']);
  });
  it('indexes the trust tier per component', () => {
    expect(cat.tierOf('Button')).toBe('interactive');
    expect(cat.tierOf('ProgressBar')).toBe('display');
    expect(cat.tierOf('Nope')).toBeUndefined();
  });
  it('indexes the kind + permission per action', () => {
    expect(cat.kindOf('go')).toBe('exec-local');
    expect(cat.permissionOf('go')?.danger).toBe(true);
    expect(cat.kindOf('setState')).toBe('render-local');
    expect(cat.permissionOf('setState')).toBeUndefined();
  });
  it('resolves visibility/callableFrom to the default when undeclared', () => {
    expect(cat.visibilityOf('Button')).toBe('clientOnly'); // undeclared ⇒ default
    expect(cat.callableFromOf('go')).toBe('clientOnly'); // undeclared ⇒ default
    expect(cat.visibilityOf('Nope')).toBeUndefined(); // unregistered
    expect(cat.callableFromOf('nope')).toBeUndefined();
  });
  it('the adopted base exposes a prompt() method', () => {
    expect(typeof cat.base.prompt).toBe('function');
  });
});

describe('fail-closed build guards', () => {
  const okAction = {
    params: z.object({}),
    description: 'x',
    kind: 'exec-local' as const,
    permission: { danger: false, resourceTemplate: 'echo', summaryTemplate: 'Echo' },
  };
  it('rejects a top-level z.record props schema (open-data hole behind the allowlist)', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Open: {
            props: z.record(z.string(), z.unknown()),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/record/);
  });
  it('rejects a passthrough/catchall props schema hiding behind the .strict() surface', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Loose: {
            props: z.object({ a: z.string() }).catchall(z.unknown()),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/catchall|passthrough/);
  });
  it('rejects a .passthrough() props schema (open member behind the closed surface)', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Loose: {
            props: z.object({ a: z.string() }).passthrough(),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/catchall|passthrough/);
  });
  it('rejects a UNION props schema whose member is an open record', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Split: {
            props: z.union([
              z.object({ a: z.string() }).strict(),
              z.record(z.string(), z.unknown()),
            ]),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/record/);
  });
  it('rejects an unrecognized action kind — fail closed, no permissive default', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {},
        actions: {
          // deliberately illegal literal: proves the RUNTIME guard — TS alone
          // cannot stop a JSON-loaded or JS-authored catalog.
          go: { ...okAction, kind: 'yolo' as unknown as 'exec-local' },
        },
      }),
    ).toThrowError(/kind/);
  });
  it('rejects a non-render-local action missing its PermissionDescriptor', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {},
        actions: {
          go: { params: z.object({}), description: 'x', kind: 'exec-local' },
        },
      }),
    ).toThrowError(/PermissionDescriptor/);
  });
  it('rejects a secret-typed component declared wider than localOnly (fail closed)', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          // a secret token field must never be projected to the model — declaring
          // it remoteOnly is a build error, not a silent coercion.
          Token: {
            props: z.object({ token: z.string() }).strict(),
            slots: [],
            description: 'x',
            trustTier: 'interactive',
            secret: true,
            visibility: 'remoteOnly',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/secret/);
  });
  it('rejects a secret-typed component declared clientOnly (any class wider than localOnly)', () => {
    // Not only remoteOnly: clientOnly is also wider than the forced localOnly, so
    // the guard rejects it too. Exercises the branch a `=== remoteOnly` narrowing
    // would silently pass.
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Token: {
            props: z.object({ token: z.string() }).strict(),
            slots: [],
            description: 'x',
            trustTier: 'interactive',
            secret: true,
            visibility: 'clientOnly',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/secret/);
  });
});
