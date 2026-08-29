import { describe, it, expect } from 'vitest';
import { createSpecSink, systemClock } from '../src/ports/index.js';
import {
  createVisibilityChannel,
  catalogVisibilityToChannel,
  redact,
  redactDeep,
  routeObservation,
  routeToolCallResult,
  routeRuntimeFault,
  summarizeExecEvents,
} from '../src/visibility/index.js';

describe('sub-barrel value-export reachability', () => {
  it('re-exports the ports factories/values, not just their types', () => {
    expect(typeof createSpecSink).toBe('function');
    expect(typeof systemClock.now).toBe('function');
  });
  it('re-exports the visibility/error-channel factories, not just their types', () => {
    for (const fn of [
      createVisibilityChannel,
      catalogVisibilityToChannel,
      redact,
      redactDeep,
      routeObservation,
      routeToolCallResult,
      routeRuntimeFault,
      summarizeExecEvents,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});
