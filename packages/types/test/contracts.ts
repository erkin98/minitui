// Compile-time shape contracts for the public surface. surface.test.ts locks the
// export NAMES; this file locks the SHAPES of load-bearing exported types so a
// silent field/discriminant drift reds `tsc -p tsconfig.test.json` (finding C15).
// Type-only: vitest ignores it (no `.test` suffix); tsc typechecks it under the
// package's strict flags (tsconfig.test includes test/**/*.ts). No runtime code.
import type { Pointer } from '../src/pointer.js';
import type { AgentEvent, EventType } from '../src/events.js';
import type { Decision } from '../src/permission.js';
import type { ExecEvent } from '../src/ports.js';

// Invariant type-equality (distinguishes optional/readonly/union differences).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Pointer is a BRANDED string: a bare string is NOT assignable to it. The
// name-only surface golden cannot see the brand — drop it and this reds.
export type _PointerIsBranded = Expect<Equal<[string] extends [Pointer] ? true : false, false>>;

// The streamed-exec discriminant tags are exactly these four.
export type _ExecEventKinds = Expect<
  Equal<ExecEvent['kind'], 'stdout' | 'stderr' | 'progress' | 'exit'>
>;

// The deny-first decision discriminants are exactly these three.
export type _DecisionKinds = Expect<Equal<Decision['kind'], 'allow' | 'deny' | 'ask'>>;

// The AgentEvent union's discriminants EXACTLY mirror the EventType vocabulary —
// the two hand-maintained lists (EVENT_TYPES enum vs AgentEventSchema) cannot drift
// apart silently (also closes the missing EVENT_TYPES<->AgentEvent consistency gate).
export type _AgentEventMirrorsVocabulary = Expect<Equal<AgentEvent['type'], EventType>>;
