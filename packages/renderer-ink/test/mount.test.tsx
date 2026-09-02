import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mountInk, withSynchronizedOutput } from '../src/mount.js';
import type { AppSpec, JsonValue } from '@minitui/types';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { makeCatalog } from './support/make-catalog.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import { z } from 'zod';

// Text is a std json-render component; the binding resolves it because the catalog lists it.
const catalog = makeCatalog({
  components: { Text: { trustTier: 'display' }, Button: { trustTier: 'interactive' } },
  actions: {
    setState: { kind: 'render-local', params: z.object({}) },
    merge: {
      kind: 'exec-local',
      params: z.object({}),
      permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
    },
  },
});

// spec with an ANSI escape + an OSC-52 clipboard write in a Text prop.
const dirtySpec: AppSpec = {
  root: 'r',
  elements: { r: { type: 'Text', props: { text: '\u001B[31mhi\u001B]52;c;ZXZpbA==\u0007' } } },
};

// the raw controlled io (json-render StoreAdapterConfig shape) — mountInk builds the StateStore.
function controlledIo() {
  let snap: Record<string, unknown> = {};
  const subs = new Set<() => void>();
  return {
    getSnapshot: () => snap,
    setSnapshot: (n: Record<string, unknown>) => {
      snap = n;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}

// fake stdout mirroring ink-testing-library's own: 100 columns, frame-recording, NO isTTY —
// so withSynchronizedOutput passes it through and the captured frames stay escape-free.
// This is the exact stream shape the headless test harness injects.
class FakeStdout extends EventEmitter {
  get columns() {
    return 100;
  }
  readonly frames: string[] = [];
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const noopConsent = { request: undefined, subscribe: () => () => {}, resolve: () => {} };
const ok: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };

describe('mountInk prepareSpec chokepoint', () => {
  it('sanitizes spec strings at bind (no raw OSC-52 clipboard write reaches the frame)', () => {
    // Assert on the ACTUAL rendered frame (what reaches the terminal) via the io seam — the
    // real public surface — not an internal field. debug:true makes ink write each full frame to
    // our fake stdout; the fake is non-TTY so withSynchronizedOutput passes it through escape-free.
    const stdout = new FakeStdout();
    const handle = mountInk({
      spec: dirtySpec,
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
      io: { stdout: stdout as unknown as NodeJS.WriteStream, debug: true },
    });
    const frame = stdout.frames.join('');
    expect(frame).toContain('hi'); // the harmless text survived the surgical strip
    expect(frame).not.toContain(']52;c;'); // the OSC-52 clipboard-write sequence is gone
    expect(frame).not.toContain('ZXZpbA=='); // ...and so is its base64 "evil" payload
    handle.unmount();
  });

  it('re-sanitizes on update (the update path runs the SAME prepareSpec chokepoint)', () => {
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: { text: 'clean' } } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
    });
    handle.update(dirtySpec);
    // the typed activeSpec getter (test-only, erased at the renderer-port boundary) shows update()
    // ran the sanitize chokepoint — the OSC-52 clipboard write is gone from the re-prepared spec.
    expect(JSON.stringify(handle.activeSpec)).not.toContain(']52;c;');
    handle.unmount();
  });

  it('strips agent-authored confirm + onSuccess/onError callbacks (frozen action grammar)', () => {
    // The wire ActionBinding schema is strict and forbids confirm/onSuccess/onError at the type
    // level, so this agent-authored fixture is genuinely type-invalid input — built via JSON.parse
    // (which returns `any`), not a cast. json-render's action provider WOULD run onSuccess.set
    // (ungated state write) + onSuccess.action (secondary action) past the catalog gate;
    // prepareSpec strips them so only the allowlisted `action` survives.
    const attackSpec: AppSpec = JSON.parse(
      JSON.stringify({
        root: 'b',
        elements: {
          b: {
            type: 'Button',
            props: {},
            on: {
              press: {
                action: 'merge',
                params: {},
                confirm: { title: 'HACKED', message: 'HACKED' },
                onSuccess: { set: { '/pwned': 'PWNED' } },
                onError: { action: 'exit' },
              },
            },
          },
        },
      }),
    );
    const handle = mountInk({
      spec: attackSpec,
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
    });
    const activeJson = JSON.stringify(handle.activeSpec);
    expect(activeJson).not.toContain('HACKED'); // agent-authored confirm text never survives prepareSpec
    expect(activeJson).not.toContain('confirm'); // the confirm binding key itself is stripped
    expect(activeJson).not.toContain('onSuccess'); // the onSuccess callback chain is stripped
    expect(activeJson).not.toContain('onError'); // the onError callback chain is stripped
    expect(activeJson).not.toContain('PWNED'); // its ungated onSuccess.set payload never survives
    // gated binding got the element key injected for DispatchContext.elementKey — read through the typed spec.
    const raw = handle.activeSpec.elements.b?.on?.press;
    const press = Array.isArray(raw) ? raw[0] : raw;
    expect(press?.params?.__minituiElementKey).toBe('b');
    handle.unmount();
  });

  it('applyStatePatch honors ALL SIX RFC-6902 ops against the controlled io', () => {
    const io = controlledIo();
    io.setSnapshot({ a: 1, arr: ['x', 'y'] });
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    handle.applyStatePatch([
      { op: 'add', path: '/progress', value: 0.5 },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'copy', from: '/a', path: '/b' },
      { op: 'move', from: '/b', path: '/c' },
      { op: 'test', path: '/c', value: 2 },
      { op: 'remove', path: '/arr/0' },
    ]);
    const snap = io.getSnapshot() as Record<string, unknown>;
    expect(snap).toMatchObject({ progress: 0.5, a: 2, c: 2 });
    expect('b' in snap).toBe(false); // move deleted the source key
    expect(snap.arr).toEqual(['y']); // remove spliced, not holed
    expect(() => handle.applyStatePatch([{ op: 'test', path: '/a', value: 999 }])).toThrow(/test/i);
    io.setSnapshot({ source: { nested: -0 }, items: ['a', 'b', 'c'] });
    handle.applyStatePatch([{ op: 'copy', from: '/source', path: '/copy' }]);
    expect(io.getSnapshot()).toStrictEqual({
      source: { nested: -0 },
      copy: { nested: -0 },
      items: ['a', 'b', 'c'],
    });
    handle.applyStatePatch([{ op: 'copy', from: '', path: '/rootCopy' }]);
    const withRootCopy = io.getSnapshot() as Record<string, JsonValue>;
    expect(withRootCopy.rootCopy).toStrictEqual({
      source: { nested: -0 },
      copy: { nested: -0 },
      items: ['a', 'b', 'c'],
    });
    handle.applyStatePatch([{ op: 'copy', from: '/source', path: '' }]);
    expect(io.getSnapshot()).toStrictEqual({ nested: -0 });
    io.setSnapshot({ arraySource: [{ value: -0 }, -0] });
    handle.applyStatePatch([{ op: 'copy', from: '/arraySource', path: '/arrayCopy' }]);
    expect(io.getSnapshot()).toStrictEqual({
      arraySource: [{ value: -0 }, -0],
      arrayCopy: [{ value: -0 }, -0],
    });
    io.setSnapshot({ source: { nested: -0 }, items: ['a', 'b', 'c'] });
    expect(() =>
      handle.applyStatePatch([{ op: 'move', from: '/items/0', path: '/items/3' }]),
    ).toThrow();
    // banPrototypeModifications: a __proto__ path is rejected at apply, never after corruption
    expect(() =>
      handle.applyStatePatch([{ op: 'add', path: '/__proto__/evil', value: 1 }]),
    ).toThrow();
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    handle.unmount();
  });

  it('rejects a non-canonical array index and leaves the controlled snapshot unchanged', () => {
    const io = controlledIo();
    io.setSnapshot({ items: ['a', 'b'] });
    const before = io.getSnapshot();
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    expect(() =>
      handle.applyStatePatch([{ op: 'replace', path: '/items/01', value: 'x' }]),
    ).toThrow(/array index/i);
    expect(io.getSnapshot()).toBe(before);
    handle.unmount();
  });

  it('rejects an inherited source member and leaves the controlled snapshot unchanged', () => {
    const io = controlledIo();
    io.setSnapshot({ own: true });
    const before = io.getSnapshot();
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    expect(() =>
      handle.applyStatePatch([{ op: 'copy', from: '/toString', path: '/copied' }]),
    ).toThrow(/does not exist/i);
    expect(io.getSnapshot()).toBe(before);
    handle.unmount();
  });

  it('rejects pointer depth before token allocation and leaves the snapshot unchanged', () => {
    const io = controlledIo();
    io.setSnapshot({ safe: true });
    const before = io.getSnapshot();
    const tooDeep = `/${Array.from({ length: 257 }, () => 'x').join('/')}`;
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    expect(() => handle.applyStatePatch([{ op: 'add', path: tooDeep, value: 1 }])).toThrow(
      /max depth/i,
    );
    expect(io.getSnapshot()).toBe(before);
    handle.unmount();
  });

  it('rejects root removal at the object-rooted renderer boundary atomically', () => {
    const io = controlledIo();
    io.setSnapshot({ safe: true });
    const before = io.getSnapshot();
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    expect(() => handle.applyStatePatch([{ op: 'remove', path: '' }])).toThrow();
    expect(io.getSnapshot()).toBe(before);
    handle.unmount();
  });

  it('bounds repeated root-copy growth without committing a partial snapshot', () => {
    const io = controlledIo();
    io.setSnapshot({ seed: true });
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: io,
      consent: noopConsent,
    });
    const copies = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        op: 'copy' as const,
        from: '',
        path: `/copy${index}`,
      }));
    handle.applyStatePatch(copies(10));
    expect(io.getSnapshot()).toHaveProperty('copy9');
    io.setSnapshot({ seed: true });
    const before = io.getSnapshot();
    expect(() =>
      handle.applyStatePatch([...copies(16), { op: 'test', path: '/seed', value: false }]),
    ).toThrow(/max node count/i);
    expect(io.getSnapshot()).toBe(before);
    handle.unmount();
  });

  it('mounting an off-catalog component throws SYNCHRONOUSLY (pre-render assert — the boundary would swallow a render throw)', () => {
    const offSpec: AppSpec = {
      root: 'e',
      elements: { e: { type: 'EvilWidget', props: {} } },
    };
    expect(() =>
      mountInk({
        spec: offSpec,
        catalog,
        binding: createInkBinding(catalog),
        dispatcher: ok,
        store: controlledIo(),
        consent: noopConsent,
      }),
    ).toThrow(/EvilWidget.*catalog allowlist/i);
  });

  it('update() with an off-catalog spec throws through the same gate', () => {
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: {} } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
    });
    expect(() =>
      handle.update({ root: 'e', elements: { e: { type: 'EvilWidget', props: {} } } }),
    ).toThrow(/EvilWidget/i);
    handle.unmount();
  });

  it('an off-catalog STD component (Spinner) is rejected too — includeStandard must not leak the std 27', () => {
    // Spinner IS one of json-render's std 27 but is NOT in this test catalog -> must be rejected.
    const stdSpec: AppSpec = { root: 's', elements: { s: { type: 'Spinner', props: {} } } };
    expect(() =>
      mountInk({
        spec: stdSpec,
        catalog,
        binding: createInkBinding(catalog),
        dispatcher: ok,
        store: controlledIo(),
        consent: noopConsent,
      }),
    ).toThrow(/Spinner/i);
  });

  it('an off-catalog action in a binding is rejected by the same synchronous walk', () => {
    const actionSpec: AppSpec = {
      root: 'b',
      elements: {
        b: { type: 'Button', props: {}, on: { press: { action: 'evilAction', params: {} } } },
      },
    };
    expect(() =>
      mountInk({
        spec: actionSpec,
        catalog,
        binding: createInkBinding(catalog),
        dispatcher: ok,
        store: controlledIo(),
        consent: noopConsent,
      }),
    ).toThrow(/evilAction.*not in the catalog allowlist/i);
  });

  it('a catalog-listed component the binding cannot resolve renders the loud fallback, never a std leak', () => {
    // The pre-render assert passes (Spinner IS in this catalog), the registry map has no entry
    // for it (the binding resolves nothing), and Spinner is one of json-render's std 27 — so the
    // ONLY thing keeping the std implementation out of the frame is the forced
    // includeStandard={false}. Flipping it to the library default would render the real std
    // Spinner here instead of the loud fallback marker.
    const spinnerCatalog = makeCatalog({ components: { Spinner: { trustTier: 'display' } } });
    const stdout = new FakeStdout();
    const handle = mountInk({
      spec: { root: 's', elements: { s: { type: 'Spinner', props: {} } } },
      catalog: spinnerCatalog,
      binding: { catalogId: 'unresolving', resolve: () => undefined },
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
      io: { stdout: stdout as unknown as NodeJS.WriteStream, debug: true },
    });
    const frame = stdout.frames.join('');
    expect(frame).toContain('off-catalog: Spinner'); // fallback marker — the std registry stayed out
    handle.unmount();
  });

  it('forwards io.{stdout,stderr,stdin,debug} into ink render — the headless-capture seam', () => {
    // The headless test harness injects ink-testing-library-shaped fake streams HERE; without
    // the io passthrough mountInk would hardwire process.stdout and no headless suite could
    // capture frames. debug:true makes ink write each full frame straight to our stdout.
    const stdout = new FakeStdout();
    const handle = mountInk({
      spec: { root: 'r', elements: { r: { type: 'Text', props: { text: 'HELLO-FRAME' } } } },
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: ok,
      store: controlledIo(),
      consent: noopConsent,
      io: { stdout: stdout as unknown as NodeJS.WriteStream, debug: true },
    });
    // ink wrote the rendered frame to OUR stdout, not process.stdout (std Text renders props.text).
    expect(stdout.frames.join('')).toContain('HELLO-FRAME');
    // the fake is non-TTY, so withSynchronizedOutput passed it through untouched — no DEC-2026 leak.
    expect(stdout.frames.join('')).not.toContain('\u001B[?2026h');
    handle.unmount();
  });
});

// DEC-2026 synchronized output: bracket each TTY stdout write in begin/end-synchronized-update
// escapes so streaming frames cannot tear on capable terminals; unsupported terminals ignore
// the private-mode escapes, and non-TTY streams (pipe/CI) are passed through untouched.
describe('withSynchronizedOutput (DEC-2026 tear-free frame bracketing)', () => {
  it('brackets each TTY write in ESC[?2026h … ESC[?2026l', () => {
    const writes: string[] = [];
    const fake = {
      isTTY: true,
      write: (s: unknown) => {
        writes.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const ok = withSynchronizedOutput(fake).write('FRAME');
    expect(ok).toBe(true);
    expect(writes).toEqual(['\u001B[?2026h', 'FRAME', '\u001B[?2026l']);
  });

  it('passes columns/rows/isTTY through so ink still measures the viewport', () => {
    const fake = {
      isTTY: true,
      columns: 100,
      rows: 40,
      write: () => true,
    } as unknown as NodeJS.WriteStream;
    const wrapped = withSynchronizedOutput(fake);
    expect(wrapped.columns).toBe(100);
    expect(wrapped.rows).toBe(40);
    expect(wrapped.isTTY).toBe(true);
  });

  it('leaves a non-TTY stream (pipe/CI) untouched — no escapes leak into logs', () => {
    const fake = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
    expect(withSynchronizedOutput(fake)).toBe(fake);
  });
});
