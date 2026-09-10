/**
 * Catalog-domain repair WORDING contributed into the self-correct loop.
 * @minitui/spec is the SOLE owner of the fault->envelope->reprompt build (its
 * `toRuntimeRepair` — spec already owns the RUNTIME_ERROR envelope + the compose
 * loop); this catalog package only supplies the domain-specific remedy hint
 * spec's builder appends. Three-component chain: (1) @minitui/catalog
 * contributes this wording -> (2) @minitui/spec's toRuntimeRepair(err, wording)
 * builds the RUNTIME_ERROR envelope + reprompt -> (3) agent-core's
 * observation-router CALLS toRuntimeRepair with the wording injected by the
 * composition root (agent-core cannot import catalog). A plain constant, not a
 * fault->string builder, so there is exactly ONE fault->reprompt builder in the
 * system (spec's), never two that can drift.
 */
export const CATALOG_REPAIR_WORDING =
  'Adjust the action parameters, codecs, filters, or file paths so the action can succeed.';
