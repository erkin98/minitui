// @minitui/transport public surface — curated named barrel.

// agent seam
export type { AgentPort, RunHandle } from './agent/agent-port.js';
export { createLocalAgentPort } from './agent/local-agent.js';
export { createAgUiAgentPort } from './agent/ag-ui-agent.js';
export { toAgUiEvent } from './agent/to-ag-ui.js';
export type { AgUiSynthesisContext } from './agent/to-ag-ui.js';
export { buildRunAgentInput } from './agent/run-input.js';
export { createAbort } from './agent/abort.js';
export { subscribeToObservable } from './agent/subscribe.js';

// events
export type { AppEvent, AppEventKind } from './events/app-event.js';
export { toAppEvent } from './events/to-app-event.js';
export type { WireEvent } from './events/to-app-event.js';
export { CONSUMED_KINDS } from './events/event-kinds.js';

// state
export type { JsonValue, Pointer } from './state/json-pointer.js';
export { parsePointer, getIn, setIn, removeIn } from './state/json-pointer.js';
export { applyStatePatch, PatchError } from './state/patch-apply.js';
export type { JsonPatchOp } from './state/patch-apply.js';
export type { DataStore } from './state/data-store.js';
export { createDataStore } from './state/data-store.js';
export type { StorePort } from './state/store-port.js';
export { sanitizeStrings, foldSnapshot, foldDelta } from './state/snapshot-delta.js';

// bus
export type { AppBus } from './bus/app-bus.js';
export { createAppBus } from './bus/app-bus.js';
export type { BusPort } from './bus/bus-port.js';
export type { Topic, TopicPayloads } from './bus/topics.js';
export { COALESCIBLE } from './bus/topics.js';
export { BoundedQueue } from './bus/backpressure.js';

// channels
export type { AppError } from './channels/error-channel.js';
export { toAppError } from './channels/error-channel.js';
export { toVisibilityNote } from './channels/visibility-channel.js';
export { buildActionUplink } from './channels/action-uplink.js';
export type { UplinkEvents } from './channels/action-uplink.js';

// seams
export type { ActionDispatcherPort } from './seams/dispatcher-port.js';
export type { RendererFeedPort } from './seams/renderer-feed-port.js';

// sequencing
export type { SeqGuard, SeqVerdict } from './sequencing/seq-guard.js';
export { createSeqGuard } from './sequencing/seq-guard.js';
