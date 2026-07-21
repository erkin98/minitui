import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { subscribeToObservable } from '../src/agent/subscribe.js';

describe('subscribeToObservable (rxjs quarantine bridge)', () => {
  it('forwards emitted values to the callback', () => {
    const subj = new Subject<number>();
    const seen: number[] = [];
    subscribeToObservable(subj, (v) => seen.push(v));
    subj.next(1);
    subj.next(2);
    expect(seen).toEqual([1, 2]);
  });

  it('unsubscribe stops delivery', () => {
    const subj = new Subject<number>();
    let seen = 0;
    const off = subscribeToObservable(subj, () => {
      seen++;
    });
    off();
    subj.next(99);
    expect(seen).toBe(0);
  });

  it('an aborted signal unsubscribes', () => {
    const subj = new Subject<number>();
    let seen = 0;
    const ac = new AbortController();
    subscribeToObservable(
      subj,
      () => {
        seen++;
      },
      { signal: ac.signal },
    );
    ac.abort();
    subj.next(7);
    expect(seen).toBe(0);
  });

  it('routes onComplete', () => {
    const subj = new Subject<number>();
    let completed = 0;
    subscribeToObservable(subj, () => {}, {
      onComplete: () => {
        completed++;
      },
    });
    subj.complete();
    expect(completed).toBe(1);
  });
});
