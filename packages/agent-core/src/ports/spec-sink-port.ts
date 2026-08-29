import type { AppSpec } from '@minitui/types';
import type { MinituiEvent } from '../events/index.js';
import { activitySnapshot } from '../events/index.js';

// A generated spec leaves the loop as an ACTIVITY_SNAPSHOT event and renders
// nothing here — the renderer is a downstream consumer of the event stream.
export interface SpecSinkPort {
  emit(spec: AppSpec): MinituiEvent;
}

export function createSpecSink(): SpecSinkPort {
  return { emit: (spec) => activitySnapshot(spec) };
}
