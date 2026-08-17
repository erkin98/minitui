import { describe, it, expect } from 'vitest';
import { createAppBus } from '../src/bus/app-bus.js';
import type { BusPort } from '../src/bus/bus-port.js';
import type { Topic } from '../src/bus/topics.js';

// BusPort.publish must correlate a topic with its payload even when the caller holds the topic in a
// widened `Topic` variable rather than a literal. A generic signature
// `<T extends Topic>(topic: T, payload: TopicPayloads[T])` infers `T = Topic` for a widened topic,
// collapsing `payload` to the union of every payload type (which includes `string`) — so a raw
// string was accepted for 'error'. The distributed tuple union in `publish`'s real parameter list
// has no such collapse: `[Topic, string]` matches no member.
//
// This is a compile-time contract, so the witnesses below are module-level `const` assignments
// checked by `tsc -p tsconfig.test.json` (part of `pnpm typecheck`) — the vitest runtime cannot see
// types. `AcceptsArgs` reads the correlation straight off the production signature via
// `Parameters<BusPort['publish']>`, so regressing that signature to the generic form is what moves
// the witnesses and reds the typecheck.
type AcceptsArgs<Args extends readonly unknown[]> =
  Args extends Parameters<BusPort['publish']> ? true : false;

// NEGATIVE witness: a widened topic paired with a raw-string payload must be REJECTED. If publish
// regresses to `<T extends Topic>(topic, payload)`, `[Topic, string]` becomes assignable, this
// resolves to `true`, and the `: false` annotation stops compiling — `tsc` reds here.
const widenedMismatchRejected: AcceptsArgs<[Topic, string]> = false;
// POSITIVE control: a correctly correlated tuple must be ACCEPTED, proving the negative above is a
// real discriminator and not a signature that rejects every tuple.
const correlatedAccepted: AcceptsArgs<['error', { message: string; retriable: boolean }]> = true;

describe('BusPort topic/payload correlation', () => {
  it('proves the correlation at compile time (the module-level witnesses are the gate)', () => {
    // The load-bearing assertions are the `: false` / `: true` annotations above, under `tsc`. This
    // references the resolved values so lint retains them and a reader sees what the type check
    // decided; it is not itself the proof — the vitest run never typechecks.
    expect({ widenedMismatchRejected, correlatedAccepted }).toEqual({
      widenedMismatchRejected: false,
      correlatedAccepted: true,
    });
  });

  it('accepts a correctly-typed literal-topic call and delivers it at runtime', () => {
    const bus = createAppBus();
    const seen: Array<{ message: string; retriable: boolean }> = [];
    bus.subscribe('error', (p) => seen.push(p));
    bus.publish('error', { message: 'x', retriable: false });
    expect(seen).toEqual([{ message: 'x', retriable: false }]);
  });
});
