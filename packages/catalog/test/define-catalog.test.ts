import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ACTION_KINDS } from '@minitui/types';
import { defineMinituiCatalog } from '../src/define-catalog.js';
import {
  standardActionDefinitions,
  standardComponentDefinitions,
  type ActionDefinition,
} from '../src/schema-bridge.js';
import type { PermissionDescriptor } from '../src/contract/action-kind.js';
import { defineComponent } from '../src/contract/catalog-component.js';
import { defineAction } from '../src/contract/catalog-action.js';

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
    // a kind read from JSON is the untrusted shape the runtime guard exists for
    const illegalKind: 'exec-local' = JSON.parse('"yolo"');
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {},
        actions: {
          // proves the RUNTIME guard — TS alone cannot stop a JSON-loaded or JS-authored catalog.
          go: { ...okAction, kind: illegalKind },
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
  it('rejects a ZodIntersection props schema whose member is an open record', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Split: {
            props: z.intersection(
              z.object({ a: z.string() }).strict(),
              z.record(z.string(), z.unknown()),
            ),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/record/);
  });
  it('rejects a ZodPipe props schema whose INPUT surface is an open record', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'bad',
        components: {
          Piped: {
            props: z.record(z.string(), z.unknown()).pipe(z.object({ a: z.string() }).strict()),
            slots: [],
            description: 'x',
            trustTier: 'display',
          },
        },
        actions: { go: okAction },
      }),
    ).toThrowError(/record/);
  });
});

describe('ActionKind set imported from @minitui/types (no hand-copied drift)', () => {
  it('accepts every canonical ActionKind (a stale local copy would reject a valid kind)', () => {
    for (const kind of ACTION_KINDS) {
      expect(() =>
        defineMinituiCatalog({
          id: 'kinds',
          components: {},
          actions: {
            a: {
              params: z.object({}),
              description: 'x',
              kind,
              permission: { danger: false, resourceTemplate: 'echo', summaryTemplate: 'Echo' },
            },
          },
        }),
      ).not.toThrow();
    }
  });
});

describe('definition guard', () => {
  const withProps = (props: z.ZodType) => () =>
    defineMinituiCatalog({
      id: 'guard',
      components: { C: { props, slots: [], description: 'c', trustTier: 'display' } },
      actions: {},
    });
  const withParams = (params: z.ZodType) => () =>
    defineMinituiCatalog({
      id: 'guard',
      components: {},
      actions: { a: { params, description: 'a', kind: 'render-local' } },
    });
  const withPermission = (permission: PermissionDescriptor) => () =>
    defineMinituiCatalog({
      id: 'guard',
      components: {},
      actions: {
        a: { params: z.object({}), description: 'a', kind: 'exec-local', permission },
      },
    });
  const open = z.record(z.string(), z.unknown());

  it.each<[string, z.ZodType]>([
    ['z.any()', z.any()],
    ['z.unknown()', z.unknown()],
    ['an optional record', open.optional()],
    ['a nullable record', open.nullable()],
    ['a defaulted record', open.default({})],
    ['a lazy record', z.lazy(() => open)],
    [
      'a union of closed objects',
      z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.string() }).strict()]),
    ],
    ['a string', z.string()],
  ])('refuses component props that are %s', (_name, props) => {
    expect(withProps(props)).toThrowError(/"C" props.*z\.object/);
  });

  it.each<[string, z.ZodType, RegExp]>([
    ['a record', open, /record/],
    ['z.any()', z.any(), /"a" params.*z\.object/],
    ['an optional record', open.optional(), /"a" params.*z\.object/],
    ['a passthrough object', z.object({ a: z.string() }).passthrough(), /passthrough|catchall/],
  ])('refuses action params that are %s', (_name, params, message) => {
    expect(withParams(params)).toThrowError(message);
  });

  it('refuses an object with a refinement, which has no partial form', () => {
    const refined = z
      .object({ a: z.string() })
      .strict()
      .refine(() => true);
    expect(withProps(refined)).toThrowError(/"C" props.*partial/);
    expect(withParams(refined)).toThrowError(/"a" params.*partial/);
  });

  it('refuses a permission that is not a descriptor', () => {
    expect(withPermission(JSON.parse('{}'))).toThrowError(/"a".*permission/);
  });

  it('refuses a template hole that does not name a pointer', () => {
    const hole = { danger: true, resourceTemplate: 'ffmpeg ${codec}', summaryTemplate: 'Merge' };
    expect(withPermission(hole)).toThrowError(/"a".*\$\{codec\}/);
    const summary = { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'Use ${codec}' };
    expect(withPermission(summary)).toThrowError(/"a".*\$\{codec\}/);
  });

  it('accepts every adopted standard component and action definition', () => {
    const components = Object.fromEntries(
      Object.entries(standardComponentDefinitions).map(([name, def]) => [
        name,
        defineComponent({ ...def, trustTier: 'display' }),
      ]),
    );
    const local = (def: ActionDefinition) =>
      defineAction({ ...def, kind: 'render-local' as const });
    const actions = Object.fromEntries(
      Object.entries(standardActionDefinitions).map(([name, def]) => [name, local(def)]),
    );
    expect(() => defineMinituiCatalog({ id: 'std', components, actions })).not.toThrow();
  });

  it('accepts a well-formed gated action with pointer holes', () => {
    const permission = {
      danger: true,
      resourceTemplate: 'ffmpeg -i ${/inputs/0}',
      summaryTemplate: 'Merge into ${/output}',
    };
    expect(withPermission(permission)).not.toThrow();
  });

  it('does not refuse a render-local action that carries a danger permission', () => {
    expect(() =>
      defineMinituiCatalog({
        id: 'guard',
        components: {},
        actions: {
          a: {
            params: z.object({}),
            description: 'a',
            kind: 'render-local',
            permission: { danger: true, resourceTemplate: 'x', summaryTemplate: 'y' },
          },
        },
      }),
    ).not.toThrow();
  });
});
