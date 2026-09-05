import type {
  VisibilityClass as CatalogVisibilityClass,
  CatalogVisibilitySource,
} from '@minitui/types';

export type VisibilityClass = 'localOnly' | 'modelVisible' | 'modelOnly';

/**
 * The field→class map a VisibilityChannel enforces (the channel axis: STATE projection to the model).
 * Built by catalogVisibilityToChannel from the catalog's builder-owned visibility metadata — never
 * agent-authored.
 */
export type VisibilityMap = Readonly<Record<string, VisibilityClass>>;

export interface VisibilityChannel {
  classOf(fieldKey: string): VisibilityClass;
  isModelVisible(fieldKey: string): boolean;
  projectForModel(state: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export function createVisibilityChannel(classes: VisibilityMap): VisibilityChannel {
  // Freeze a private copy so the channel's view cannot drift after construction.
  const map: VisibilityMap = Object.freeze({ ...classes });

  const classOf = (fieldKey: string): VisibilityClass => map[fieldKey] ?? 'localOnly';
  const isModelVisible = (fieldKey: string): boolean => classOf(fieldKey) !== 'localOnly';

  return {
    classOf,
    isModelVisible,
    projectForModel(state) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(state)) {
        if (isModelVisible(k)) out[k] = v;
      }
      return out;
    },
  };
}

// The catalog field-visibility axis (WHERE a field is callable) and the minimal built-catalog view
// catalogVisibilityToChannel reads BOTH live in @minitui/types as the single source of truth, imported at
// the top of this file (never re-declared) so a shape drift with @minitui/catalog's MinituiCatalog reds
// `tsc -b`. agent-core reaches types directly (its allowed edges are types, transport, spec, sanitizer)
// without importing @minitui/catalog. CatalogVisibilityClass is the imported alias for this CATALOG axis
// (localOnly | clientOnly | remoteOnly) — a DIFFERENT axis from the model-visibility CHANNEL
// VisibilityClass above; the two vocabularies must never be unified, meeting only through the one-way
// adapter below.
export type { CatalogVisibilityClass, CatalogVisibilitySource };

/**
 * catalog axis → channel axis. A localOnly (secret / host-only) field, a clientOnly field (the default:
 * local renderer only, NOT projected), and any unknown class all stay off the wire (fail-private); ONLY
 * remoteOnly (projected / remote-callable) becomes modelVisible. Never yields modelOnly — that channel
 * class is reserved for host-authored context the catalog does not describe.
 */
function toChannelClass(cat: CatalogVisibilityClass | undefined): VisibilityClass {
  return cat === 'remoteOnly' ? 'modelVisible' : 'localOnly';
}

/**
 * The builder-owned adapter that makes catalog visibility metadata the RUNTIME authority for the
 * model-visibility channel. A ONE-WAY translation between two DIFFERENT axes, never a merge: catalog
 * localOnly (secret-typed / host-only) AND clientOnly (the default — local renderer only, NOT projected)
 * → channel localOnly (NEVER projected to the model); ONLY remoteOnly (projected / remote-callable)
 * → modelVisible; an unknown/undeclared name → localOnly (fail-private). Governs BOTH surfaces — component
 * keys drive STATE PROJECTION, action keys drive CALLBACK-PARAM exposure. The cli builds a NON-empty
 * channel with createVisibilityChannel(catalogVisibilityToChannel(catalog)).
 */
export function catalogVisibilityToChannel(catalog: CatalogVisibilitySource): VisibilityMap {
  const map: Record<string, VisibilityClass> = {};
  // Fail-private on a component/action name collision: a localOnly (secret / host-only) mapping is
  // NEVER widened to modelVisible (the moat) — the more-private class always wins.
  const put = (key: string, cls: VisibilityClass): void => {
    map[key] = map[key] === 'localOnly' || cls === 'localOnly' ? 'localOnly' : 'modelVisible';
  };
  for (const component of catalog.componentNames)
    put(component, toChannelClass(catalog.visibilityOf(component)));
  for (const action of catalog.actionNames)
    put(action, toChannelClass(catalog.callableFromOf(action)));
  return map;
}
