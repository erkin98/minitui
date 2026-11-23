import { setImmediate as nextTurn } from 'node:timers/promises';
import { EFFORTS, type Effort } from '@minitui/agent-core';

/** One trial to run: the item (a case), its 1-based position among the selected cases, the trial, the arm. */
export interface Job<C> {
  readonly item: C;
  readonly index: number;
  readonly trial: number;
  readonly arm: Effort;
}

/**
 * The counterbalanced arm order: in trial t of the case at position i among the selected cases, the arms
 * run from the highest effort down when i + t is even and from the lowest up otherwise, so with medium and
 * high each runs first in half the pairs and drift over a run hits both alike.
 */
export function armOrder(arms: readonly Effort[], index: number, trial: number): Effort[] {
  const ascending = EFFORTS.filter((effort) => arms.includes(effort));
  return (index + trial) % 2 === 0 ? ascending.toReversed() : ascending;
}

/**
 * Runs the cases on up to `concurrency` slots, the trials of one case one at a time, in the arm order
 * above. No trial starts once `stopped` says so, or once a trial threw, even one that threw in the tick
 * another trial ended in: the trials already running finish.
 * Resolves with what the first throw was, or null when nothing threw.
 */
export async function schedule<C>(args: {
  readonly items: readonly C[];
  readonly arms: readonly Effort[];
  readonly trials: number;
  readonly concurrency: number;
  readonly stopped: () => boolean;
  readonly run: (job: Job<C>) => Promise<void>;
}): Promise<{ readonly error: unknown } | null> {
  const queue = args.items.map((item, i) => ({ item, index: i + 1 }));
  let halt: { readonly error: unknown } | null = null;
  const idle = (): boolean => halt !== null || args.stopped();
  const runCase = async (item: C, index: number): Promise<void> => {
    for (let trial = 1; trial <= args.trials; trial += 1) {
      for (const arm of armOrder(args.arms, index, trial)) {
        // One turn of the event loop first: a throw that settled in the tick this slot's last trial
        // ended in has reached `halt` by then, however many microtasks it takes.
        await nextTurn();
        if (idle()) return;
        await args.run({ item, index, trial, arm });
      }
    }
  };
  const slot = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined && !idle(); next = queue.shift()) {
      try {
        await runCase(next.item, next.index);
      } catch (error) {
        halt ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, slot));
  return halt;
}
