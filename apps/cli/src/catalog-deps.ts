import { z } from 'zod';
import type { MinituiCatalog } from '@minitui/catalog';

/** What the parameter check needs of the catalog. */
export interface ParamsCatalog {
  readonly actionDefs: ReadonlyMap<string, { readonly params: z.ZodType }>;
}

/**
 * The check the host runs on the final parameters of a gated action, after the live values are in. The
 * action's schema must accept them, and every key must be a key of the schema: a parse of an object
 * schema drops the keys it does not know, so a key a renderer added (the merge `mode`) would pass the
 * parse and still reach exec. A schema that is not an object cannot be checked for keys, so it refuses.
 */
export function checkActionParams(
  catalog: ParamsCatalog,
  name: string,
  params: Readonly<Record<string, unknown>>,
): boolean {
  const schema = catalog.actionDefs.get(name)?.params;
  if (!(schema instanceof z.ZodObject)) return false;
  if (!schema.safeParse(params).success) return false;
  return Object.keys(params).every((key) => Object.hasOwn(schema.shape, key));
}

/**
 * The four lookups the host takes from the catalog, because it cannot import it: the parameter check, who
 * may call an action, the kind of an action and its permission descriptor. The host trusts none of these
 * values from a renderer's context; it asks here.
 */
export function hostCatalogDeps(catalog: MinituiCatalog): {
  checkParams: (name: string, params: Readonly<Record<string, unknown>>) => boolean;
  callableFromOf: MinituiCatalog['callableFromOf'];
  kindOf: MinituiCatalog['kindOf'];
  permissionOf: MinituiCatalog['permissionOf'];
} {
  return {
    checkParams: (name, params) => checkActionParams(catalog, name, params),
    callableFromOf: (name) => catalog.callableFromOf(name),
    kindOf: (name) => catalog.kindOf(name),
    permissionOf: (name) => catalog.permissionOf(name),
  };
}
