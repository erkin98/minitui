import { describe, it, expect } from 'vitest';
import { createDataStore } from '../src/state/data-store.js';

const ESC = '\u001b'; // real ESC byte — sanitize (imported directly by snapshot-delta, §Z11) strips CSI at the store ingress

describe('DataStore (canonical immutable state seam)', () => {
  it('seeds from initial and reads via getIn', () => {
    const store = createDataStore({ initial: { merge: { progress: 0 } } });
    expect(store.getIn('/merge/progress')).toBe(0);
  });

  it('applySnapshot strips model ANSI and replaces state', () => {
    const store = createDataStore();
    store.applySnapshot({ title: `a${ESC}[0mb` });
    expect(store.getState()).toEqual({ title: 'ab' }); // CSI stripped on ingress (Task 6 covers deep/immutable)
  });

  it('applyDelta folds an RFC-6902 patch and notifies subscribers', () => {
    const store = createDataStore({ initial: { p: 0 } });
    const seen: unknown[] = [];
    store.subscribe((s) => {
      seen.push(s);
    });
    store.applyDelta([{ op: 'replace', path: '/p', value: 9 }]);
    expect(store.getState()).toEqual({ p: 9 });
    expect(seen).toEqual([{ p: 9 }]);
  });

  it('setLocal mutates the SAME canonical doc immutably (new object each time)', () => {
    const store = createDataStore({ initial: {} });
    const before = store.getState();
    store.setLocal('/codec', 'h264');
    expect(store.getState()).toEqual({ codec: 'h264' });
    expect(store.getState()).not.toBe(before);
  });

  it('setLocal suppresses a same-value write: no notify, same doc (§Z30)', () => {
    const store = createDataStore({ initial: { codec: 'h264' } });
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    const before = store.getState();
    store.setLocal('/codec', 'h264'); // identical value -> no-op
    expect(notifications).toBe(0); // subscribers NOT notified
    expect(store.getState()).toBe(before); // no new object committed
    store.setLocal('/codec', 'vp9'); // a real change still commits + notifies
    expect(notifications).toBe(1);
    expect(store.getState()).toEqual({ codec: 'vp9' });
  });
});
