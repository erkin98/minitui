import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { Observable, Subject } from 'rxjs';
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

  it('does not subscribe when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    let subscriptions = 0;
    const observable = new Observable<number>(() => {
      subscriptions += 1;
    });

    subscribeToObservable(observable, () => {}, { signal: controller.signal });
    expect(subscriptions).toBe(0);
  });

  it('removes the abort listener on manual unsubscribe, completion, and error', () => {
    const manualController = new AbortController();
    const manual = new Subject<number>();
    const off = subscribeToObservable(manual, () => {}, { signal: manualController.signal });
    expect(getEventListeners(manualController.signal, 'abort')).toHaveLength(1);
    off();
    expect(getEventListeners(manualController.signal, 'abort')).toHaveLength(0);

    const completeController = new AbortController();
    const completed = new Subject<number>();
    subscribeToObservable(completed, () => {}, { signal: completeController.signal });
    completed.complete();
    expect(getEventListeners(completeController.signal, 'abort')).toHaveLength(0);

    const errorController = new AbortController();
    const errored = new Subject<number>();
    subscribeToObservable(errored, () => {}, {
      signal: errorController.signal,
      onError: () => {},
    });
    errored.error(new Error('expected'));
    expect(getEventListeners(errorController.signal, 'abort')).toHaveLength(0);
  });
});
