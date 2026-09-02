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
// Import the PACKAGE barrel by name so the `export *` sub-barrel forwards + the explicit value exports
// are exercised at THIS file — the exact site a value re-export can silently collapse to type-only.
import * as pkg from '../src/index.js';

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

describe('package barrel (src/index.ts) value-export reachability', () => {
  it('forwards every public runtime VALUE (a type-only re-export regression reds here)', () => {
    // The explicit named value exports + the `export *` sub-barrel forwards must all resolve as runtime
    // values, not erase to types. `undefined` here means a value re-export collapsed to type-only.
    for (const name of [
      'AgentSession',
      'createAiSdkProvider',
      'createAnthropicModel',
      'createMockProvider',
      'createProviderRegistry',
      'repeatedToolCallDetector',
      'isTerminal',
      'ProviderError',
      'ContextOverflowError',
      'RouteError',
      'toRunError',
      // wildcard-forwarded from ./ports and ./visibility
      'createSpecSink',
      'systemClock',
      'createVisibilityChannel',
      'redact',
      'routeToolCallResult',
      'summarizeExecEvents',
    ]) {
      expect(
        pkg[name as keyof typeof pkg],
        `barrel value export "${name}" is missing`,
      ).toBeDefined();
    }
    expect(typeof pkg.DEFAULT_STEP_CEILING).toBe('number');
  });
});
