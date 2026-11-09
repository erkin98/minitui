import { describe, it, expect } from 'vitest';
import { createDataStore } from '@minitui/transport';
import {
  bindDenialToStore,
  bindExecEventToStore,
  createRendererStoreIo,
  STATUS_CAP,
} from '../src/store-bridge.js';

const seeded = () => createDataStore({ initial: { merge: { progress: 0, status: '' } } });
const mergeOf = (store: ReturnType<typeof seeded>): unknown => {
  const state = store.getState();
  return typeof state === 'object' && state !== null ? Reflect.get(state, 'merge') : undefined;
};

describe('bindExecEventToStore', () => {
  it('writes a progress value to the progress pointer', () => {
    const store = seeded();
    bindExecEventToStore(store)({ kind: 'progress', value: 0.5 });
    expect(mergeOf(store)).toEqual({ progress: 0.5, status: '' });
  });

  it('writes the exit as done or as a failure with its code', () => {
    const store = seeded();
    const bridge = bindExecEventToStore(store);
    bridge({ kind: 'exit', code: 0 });
    expect(mergeOf(store)).toEqual({ progress: 0, status: 'done' });
    bridge({ kind: 'exit', code: 7 });
    expect(mergeOf(store)).toEqual({ progress: 0, status: 'failed (exit 7)' });
  });

  it('writes a stderr chunk to the status pointer', () => {
    const store = seeded();
    bindExecEventToStore(store)({ kind: 'stderr', chunk: 'codec not found' });
    expect(mergeOf(store)).toEqual({ progress: 0, status: 'codec not found' });
  });

  it('bounds a stderr chunk so one long line cannot flood the screen', () => {
    const store = seeded();
    bindExecEventToStore(store)({ kind: 'stderr', chunk: 'x'.repeat(STATUS_CAP * 5) });
    expect(mergeOf(store)).toEqual({ progress: 0, status: 'x'.repeat(STATUS_CAP) });
  });

  it('drops stdout, which the merge app does not show', () => {
    const store = seeded();
    const before = store.getState();
    bindExecEventToStore(store)({ kind: 'stdout', chunk: 'ignored' });
    expect(store.getState()).toBe(before);
  });
});

describe('bindDenialToStore', () => {
  it('writes a refused merge and its reason to the status pointer', () => {
    const store = seeded();
    bindDenialToStore(store)({ actionKey: 'merge', reason: 'resolved path must be absolute' });
    expect(mergeOf(store)).toEqual({
      progress: 0,
      status: 'refused: resolved path must be absolute',
    });
  });

  it('writes nothing for an action without a status pointer', () => {
    const store = seeded();
    const before = store.getState();
    bindDenialToStore(store)({ actionKey: 'setState', reason: 'no' });
    bindDenialToStore(store)({ actionKey: 'no-such-action', reason: 'no' });
    expect(store.getState()).toBe(before);
  });

  it('bounds a long reason', () => {
    const store = seeded();
    bindDenialToStore(store)({ actionKey: 'merge', reason: 'x'.repeat(STATUS_CAP * 2) });
    const status = Reflect.get(Object(mergeOf(store)), 'status');
    expect(typeof status === 'string' ? status.length : -1).toBe(STATUS_CAP);
  });
});

describe('createRendererStoreIo', () => {
  it('returns the same snapshot object while the store has not changed', () => {
    const io = createRendererStoreIo(seeded());
    expect(io.getSnapshot()).toBe(io.getSnapshot());
  });

  it('returns a new snapshot after the store changes', () => {
    const store = seeded();
    const io = createRendererStoreIo(store);
    const before = io.getSnapshot();
    store.applyDelta([{ op: 'replace', path: '/merge/progress', value: 1 }]);
    const after = io.getSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual({ merge: { progress: 1, status: '' } });
  });

  it('a snapshot written through setSnapshot reaches the store', () => {
    const store = seeded();
    createRendererStoreIo(store).setSnapshot({ merge: { progress: 0.25, status: 'x' } });
    expect(mergeOf(store)).toEqual({ progress: 0.25, status: 'x' });
  });

  it('refuses a write that is not an object and leaves the store as it was', () => {
    const store = seeded();
    const io = createRendererStoreIo(store);
    const before = store.getState();
    const notAnObject: Record<string, unknown> = JSON.parse('5');
    expect(() => io.setSnapshot(notAnObject)).toThrow();
    expect(store.getState()).toBe(before);
  });

  it('forwards store changes to a subscriber until it unsubscribes', () => {
    const store = seeded();
    const io = createRendererStoreIo(store);
    let calls = 0;
    const unsubscribe = io.subscribe(() => {
      calls += 1;
    });
    store.applyDelta([{ op: 'replace', path: '/merge/progress', value: 1 }]);
    expect(calls).toBe(1);
    unsubscribe();
    store.applyDelta([{ op: 'replace', path: '/merge/progress', value: 2 }]);
    expect(calls).toBe(1);
  });

  it('rejects a source that is not an object every time it is read, and recovers once it is one', () => {
    const store = createDataStore({ initial: { merge: { progress: 0, status: '' } } });
    const io = createRendererStoreIo(store);
    store.applySnapshot(5);
    expect(() => io.getSnapshot()).toThrow();
    expect(() => io.getSnapshot()).toThrow();
    store.applySnapshot({ ok: true });
    const first = io.getSnapshot();
    expect(first).toEqual({ ok: true });
    expect(io.getSnapshot()).toBe(first);
  });
});
