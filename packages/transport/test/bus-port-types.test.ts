import { describe, it, expect } from 'vitest';
import { createAppBus } from '../src/bus/app-bus.js';
import type { BusPort } from '../src/bus/bus-port.js';
import type { Topic } from '../src/bus/topics.js';

// C17: BusPort.publish must correlate a topic with its payload even when the caller holds the topic
// in a widened `Topic` variable rather than a literal. The pre-fix generic signature
// `<T extends Topic>(topic: T, payload: TopicPayloads[T])` inferred `T = Topic` for a widened topic,
// collapsing `payload` to the union of every payload type (which includes `string`), so a raw
// string was accepted for 'error'. This is a compile-time proof — the value assert keeps vitest
// happy; the real gate is `tsc -p tsconfig.test.json` (part of `pnpm typecheck`).
describe('BusPort topic/payload correlation (C17)', () => {
  it('rejects a mismatched payload for a widened topic (publish)', () => {
    type PublishParams = Parameters<BusPort['publish']>;
    // A widened topic paired with a raw-string payload.
    type WidenedMismatch = [Topic, string];
    // GREEN only when the mismatched tuple is NOT assignable to publish's correlated parameters.
    type Rejected = WidenedMismatch extends PublishParams ? false : true;
    const rejected: Rejected = true;
    expect(rejected).toBe(true);
  });

  it('still accepts a correctly-typed literal-topic call at runtime', () => {
    const bus = createAppBus();
    const seen: Array<{ message: string; retriable: boolean }> = [];
    bus.subscribe('error', (p) => seen.push(p));
    bus.publish('error', { message: 'x', retriable: false });
    expect(seen).toEqual([{ message: 'x', retriable: false }]);
  });
});
