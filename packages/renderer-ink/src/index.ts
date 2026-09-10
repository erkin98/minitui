export {
  createInkRenderer,
  assertSpecOnCatalog,
  makeOffCatalogFallback,
  type InkRendererDeps,
} from './ink-renderer-port.js';
export { mountInk, type MountInkArgs } from './mount.js';
export { buildHandlers, type BuildHandlersArgs, ELEMENT_KEY } from './binder/build-handlers.js';
export { gatedHandler, type GatedHandlerArgs } from './binder/gated-handler.js';
export { RENDER_LOCAL_ALLOWLIST, isRenderLocalAllowed } from './binder/render-local.js';
export {
  ConsentOverlay,
  type ConsentController,
  type ConsentDecision,
} from './widgets/consent-overlay.js';
// Host chrome — exported barrel-direct (its mount site is a deferred product decision), never reached
// through the agent binding.
export { CommandPreview } from './widgets/command-preview.js';
export {
  createInkBinding,
  Button,
  FilePicker,
  OrderList,
  ProgressWidget,
  type WidgetProps,
} from './widgets/bindings.js';
