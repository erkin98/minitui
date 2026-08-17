/**
 * The catalog-to-widget seam: maps a catalog component id to a native widget
 * factory and its trust tier. Renderer-agnostic — the factory type `W` is the
 * concrete renderer's widget (e.g. an Ink component); renderer-core never names it.
 */
export interface WidgetCatalogBinding<W = unknown> {
  /** identifies which catalog this binding serves (e.g. 'video-merge'). */
  readonly catalogId: string;

  /**
   * Resolve a catalog component id to its native factory, trust tier, and
   * text-capture bit, or `undefined` when the component is not in this binding.
   * On `undefined` the caller MUST fail loud (throw) — never a warn-and-skip render.
   *
   * `capturesText` is surfaced from the catalog's component metadata
   * (`MinituiComponentDef.capturesText`, owner @minitui/catalog): `true` for a
   * FREE-TEXT-capturing widget whose focused handler consumes typed characters (a
   * TextInput/path-entry field), `false` for a display/select/button widget. The
   * concrete binding (renderer-ink `createInkBinding`) fills it from `def.capturesText ?? false`;
   * the app-shell reads it to decide whether the `q` key quits or is literal input.
   */
  resolve(
    componentId: string,
  ): { factory: W; trustTier: 'display' | 'interactive'; capturesText: boolean } | undefined;
}
