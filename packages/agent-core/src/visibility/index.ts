// Sub-barrel for the model-visibility / error channel. The package barrel re-exports this.
export { redact, redactDeep } from './redaction.js';
export type { RedactionPolicy } from './redaction.js';
export { createVisibilityChannel, catalogVisibilityToChannel } from './visibility-channel.js';
export type {
  VisibilityChannel,
  VisibilityClass,
  VisibilityMap,
  CatalogVisibilityClass,
  CatalogVisibilitySource,
} from './visibility-channel.js';
export {
  routeObservation,
  routeToolCallResult,
  routeRuntimeFault,
  summarizeExecEvents,
} from './observation-router.js';
export type {
  ObservationInput,
  RepairIngress,
  RuntimeRepairBuilder,
} from './observation-router.js';
