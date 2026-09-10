import { z } from 'zod';
import type { ActionKind } from '@minitui/renderer-core';
import type { MinituiCatalog, MinituiComponentDef, MinituiActionDef } from '@minitui/catalog';
import type { PermissionDescriptor } from '@minitui/types';

type ComponentSeed = { trustTier: 'display' | 'interactive'; capturesText?: boolean };
type ActionSeed = {
  kind: ActionKind;
  permission?: PermissionDescriptor | undefined;
  params?: z.ZodType;
};

// A COMPLETE, real in-memory MinituiCatalog for renderer-ink tests. Every MinituiCatalog
// field is present and derived from the two seed maps; every componentDef/actionDef is a
// complete MinituiComponentDef/MinituiActionDef (props/slots/description filled) — so no
// partial-object cast is needed anywhere. `base` is typed by the narrow prompt-only
// surface the production catalog pins for the adopted json-render catalog, so a plain
// object satisfies it without a cast. Frozen so a shared fixture can't be mutated.
export function makeCatalog(seed: {
  id?: string;
  components?: Record<string, ComponentSeed>;
  actions?: Record<string, ActionSeed>;
}): MinituiCatalog {
  const componentDefs = new Map<string, MinituiComponentDef>(
    Object.entries(seed.components ?? {}).map(([name, c]) => [
      name,
      {
        props: z.object({}),
        slots: [],
        description: name,
        trustTier: c.trustTier,
        capturesText: c.capturesText ?? false,
      },
    ]),
  );
  const actionDefs = new Map<string, MinituiActionDef>(
    Object.entries(seed.actions ?? {}).map(([name, a]) => [
      name,
      {
        params: a.params ?? z.object({}),
        description: name,
        kind: a.kind,
        permission: a.permission,
      },
    ]),
  );
  const base: MinituiCatalog['base'] = { prompt: () => '' };
  return Object.freeze({
    id: seed.id ?? 'test',
    base,
    componentNames: [...componentDefs.keys()],
    actionNames: [...actionDefs.keys()],
    tierOf: (c: string) => componentDefs.get(c)?.trustTier,
    kindOf: (a: string) => actionDefs.get(a)?.kind,
    permissionOf: (a: string) => actionDefs.get(a)?.permission,
    visibilityOf: () => undefined,
    callableFromOf: () => undefined,
    componentDefs,
    actionDefs,
  });
}
