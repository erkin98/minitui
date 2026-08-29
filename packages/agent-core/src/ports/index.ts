// Sub-barrel for the three injected ports. The package barrel re-exports this.
export type { Clock } from './clock-port.js';
export { systemClock, fixedClock, steppingClock } from './clock-port.js';
export type { ToolCallRequest, ToolCallResult, ToolDispatchPort } from './tool-dispatch-port.js';
export type { SpecSinkPort } from './spec-sink-port.js';
export { createSpecSink } from './spec-sink-port.js';
