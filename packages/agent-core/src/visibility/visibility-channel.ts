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

// An object with no prototype: a key such as `toString` or `__proto__` is an ordinary own key (or absent),
// never an inherited member and never a setter on the prototype chain.
const bare = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;

export function createVisibilityChannel(classes: VisibilityMap): VisibilityChannel {
  // Freeze a private prototype-less copy of the OWN entries, so the channel's view cannot drift after
  // construction and an inherited entry never counts.
  const copy = bare();
  for (const [key, value] of Object.entries(classes)) copy[key] = value;
  const map = Object.freeze(copy);

  // Fail private: a class counts only when its key is an own key of the copy and its value is one of the
  // three known classes. Anything else (an unknown name, an inherited name, `'public'`, `0`, `null`) is localOnly.
  const classOf = (fieldKey: string): VisibilityClass => {
    if (!Object.hasOwn(map, fieldKey)) return 'localOnly';
    const declared = map[fieldKey];
    return declared === 'modelVisible' || declared === 'modelOnly' ? declared : 'localOnly';
  };
  const isModelVisible = (fieldKey: string): boolean => classOf(fieldKey) !== 'localOnly';

  return {
    classOf,
    isModelVisible,
    projectForModel(state) {
      // Prototype-less, so a state key named `__proto__` becomes an ordinary own key of the projection.
      const out = bare();
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
  const map: Record<string, VisibilityClass> = Object.create(null) as Record<
    string,
    VisibilityClass
  >;
  // Fail-private on a component/action name collision: a localOnly (secret / host-only) mapping is
  // NEVER widened to modelVisible (the moat) — the more-private class always wins. The prior entry is
  // read as an own key only, so an inherited name never counts as one.
  const put = (key: string, cls: VisibilityClass): void => {
    const prior = Object.hasOwn(map, key) ? map[key] : undefined;
    map[key] = prior === 'localOnly' || cls === 'localOnly' ? 'localOnly' : 'modelVisible';
  };
  for (const component of catalog.componentNames)
    put(component, toChannelClass(catalog.visibilityOf(component)));
  for (const action of catalog.actionNames)
    put(action, toChannelClass(catalog.callableFromOf(action)));
  return map;
}
