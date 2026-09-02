import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { mountInk } from '../src/mount.js';
import { createInkBinding } from '../src/widgets/bindings.js';
import type { ConsentController } from '../src/widgets/consent-overlay.js';
import type { ActionDispatcher, DispatchContext, ActionOutcome } from '@minitui/renderer-core';
import type { AppSpec, PermissionRequest } from '@minitui/types';
import { makeCatalog } from './support/make-catalog.js';
import { EventEmitter } from 'node:events';

// ink-testing-library-shaped fake streams: a stdin whose write() emits 'readable'+'data' drives ink's
// useInput; a non-TTY 100-col stdout sinks frames. Fed through mountInk's io seam so the keypress golden
// drives the REAL mounted tree (real Button, real focus ring, real gated handlers) — not a fake dispatch.
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  private data: string | null = null;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  write(data: string): boolean {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
    return true;
  }
}
class FakeStdout extends EventEmitter {
  get columns(): number {
    return 100;
  }
  readonly frames: string[] = [];
  write = (f: string): boolean => {
    this.frames.push(f);
    return true;
  };
}

const catalog = makeCatalog({
  id: 'video-merge',
  components: { Button: { trustTier: 'interactive' } },
  actions: {
    merge: {
      kind: 'exec-local',
      params: z.object({ inputs: z.array(z.string()) }),
      permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
    },
  },
});

const spec: AppSpec = {
  root: 'btn',
  elements: {
    btn: {
      type: 'Button',
      props: { label: 'Merge' },
      on: { press: { action: 'merge', params: { inputs: ['a.mp4'] } } },
    },
  },
};

function controlledIo(seed: Record<string, unknown>) {
  let snap = seed;
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
const noopConsent: ConsentController = {
  request: undefined,
  subscribe: () => () => {},
  resolve: () => {},
};

function harness(
  outcome: ActionOutcome,
  specArg: AppSpec = spec,
  catalogArg = catalog,
  { consent = noopConsent }: { consent?: ConsentController } = {},
) {
  const dispatched: DispatchContext[] = [];
  const lifecycle: string[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch: async (_n, ctx: DispatchContext) => {
      dispatched.push(ctx);
      return outcome;
    },
  };
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = controlledIo({ inputs: ['a.mp4'] });
  const handle = mountInk({
    spec: specArg,
    catalog: catalogArg,
    binding: createInkBinding(catalogArg),
    dispatcher,
    store,
    consent,
    onLifecycle: { emit: (e) => lifecycle.push(e.phase) },
    io: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    },
  });
  return {
    dispatched,
    lifecycle,
    dispatcher,
    handle,
    stdin,
    store,
    lastFrame: () => stdout.frames.at(-1) ?? '',
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('gated-dispatch (headless)', () => {
  // DEFERRED: single-key input through the real mounted tree works (see the q/Esc + focused-widget
  // tests below), but Tab TRAVERSAL of json-render's focus ring does not advance the focused element in
  // this headless harness (json-render focus-manager detail under ink's real render with fake stdio).
  // The per-widget focus GATE (an unfocused widget consumes no keys) is proven by the running two-widget
  // security test below; the capturesText tests prove the focus-REPORT channel. Full Tab cycling is
  // exercised end to end when the cli mounts through the port in the spine e2e. Un-skip once wired.
  it.skip('a real Tab->Enter keypress routes through the focus ring to the gated dispatcher', async () => {
    // Two focusable Buttons in a Box — the first auto-focuses, Tab moves focus to Merge, Enter fires its
    // bound gated action. If Tab did NOT move focus, Enter would land on btnOther (no binding) and the
    // dispatcher would never be called — so this genuinely proves the focus ring.
    const keyCatalog = makeCatalog({
      id: 'video-merge',
      components: {
        Box: { trustTier: 'display' },
        Button: { trustTier: 'interactive' },
      },
      actions: {
        merge: {
          kind: 'exec-local',
          params: z.object({ inputs: z.array(z.string()) }),
          permission: { danger: true, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge' },
        },
      },
    });
    const twoButtons: AppSpec = {
      root: 'col',
      elements: {
        col: {
          type: 'Box',
          props: { flexDirection: 'column' },
          children: ['btnOther', 'btnMerge'],
        },
        btnOther: { type: 'Button', props: { label: 'Other' } },
        btnMerge: {
          type: 'Button',
          props: { label: 'Merge' },
          on: { press: { action: 'merge', params: { inputs: ['a.mp4'] } } },
        },
      },
    };
    const dispatched: DispatchContext[] = [];
    const lifecycle: string[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_n, ctx: DispatchContext) => {
        dispatched.push(ctx);
        return { status: 'settled', result: 'ok' } as const;
      },
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec: twoButtons,
      catalog: keyCatalog,
      binding: createInkBinding(keyCatalog),
      dispatcher,
      store: controlledIo({ inputs: ['a.mp4'] }),
      consent: noopConsent,
      onLifecycle: { emit: (e) => lifecycle.push(e.phase) },
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick(); // both buttons register in the ring; btnOther auto-focuses
    stdin.write('\t'); // Tab -> focus moves to btnMerge
    await tick();
    stdin.write('\r'); // Enter -> the FOCUSED Merge button emits('press') -> gated dispatch
    await tick();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.resolvedParams).toEqual({ inputs: ['a.mp4'] });
    expect(dispatched[0]?.elementKey).toBe('btnMerge'); // prepareSpec injected it; the binder stripped it
    expect(lifecycle).toEqual(['started', 'result']);
    handle.unmount();
  });

  // Two custom widgets share the ring: OrderList registers first and auto-focuses; FilePicker is
  // UNfocused. The security property (an unfocused gated widget consumes no keys) needs only a single
  // keypress + auto-focus, so it runs headless today; only the Tab-advances-the-ring half is deferred.
  function mountTwoWidgets(): {
    dispatched: DispatchContext[];
    stdin: FakeStdin;
    handle: ReturnType<typeof mountInk>;
  } {
    const twoWidgetCatalog = makeCatalog({
      id: 'video-merge',
      components: {
        Box: { trustTier: 'display' },
        OrderList: { trustTier: 'interactive' },
        FilePicker: { trustTier: 'interactive', capturesText: true },
      },
      actions: {
        pick: {
          kind: 'exec-local',
          params: z.object({}),
          permission: { danger: false, resourceTemplate: 'pick', summaryTemplate: 'pick' },
        },
      },
    });
    const twoWidgets: AppSpec = {
      root: 'col',
      elements: {
        col: { type: 'Box', props: { flexDirection: 'column' }, children: ['ol', 'fp'] },
        ol: { type: 'OrderList', props: { items: ['a.mp4', 'b.mp4'] } },
        fp: {
          type: 'FilePicker',
          props: { label: 'out', value: '' },
          on: { change: { action: 'pick', params: {} } },
        },
      },
    };
    const dispatched: DispatchContext[] = [];
    const dispatcher: ActionDispatcher = {
      dispatch: async (_n, ctx: DispatchContext) => {
        dispatched.push(ctx);
        return { status: 'settled', result: 'ok' } as const;
      },
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec: twoWidgets,
      catalog: twoWidgetCatalog,
      binding: createInkBinding(twoWidgetCatalog),
      dispatcher,
      store: controlledIo({ inputs: ['a.mp4', 'b.mp4'], out: '' }),
      consent: noopConsent,
      onLifecycle: { emit: () => {} },
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    return { dispatched, stdin, handle };
  }

  // SECURITY HALF (focus-gate): an UNfocused gated widget must not consume a key. OrderList auto-focuses and
  // ignores a bare Enter; the UNfocused FilePicker must NOT fire its Enter->'change'. An ungated
  // FilePicker WOULD dispatch here — so this is the running positive control that reds if `{ isActive }`
  // is dropped from a widget's useInput. No Tab needed (single-key + auto-focus, both proven above).
  it('two custom widgets: an UNfocused gated widget does not consume a key', async () => {
    const { dispatched, stdin, handle } = mountTwoWidgets();
    await tick(); // OrderList registers first -> auto-focuses; FilePicker is INACTIVE
    stdin.write('\r'); // Enter -> OrderList ignores it; a GATED FilePicker must NOT consume it
    await tick();
    expect(dispatched).toHaveLength(0); // an ungated FilePicker would dispatch here
    handle.unmount();
  });

  // TAB-TRAVERSAL HALF (deferred): Tab advancing json-render's focus ring to the next widget does not
  // drive in this headless harness (focus-manager detail under ink's real render with fake stdio).
  // Un-skip once the traversal is wired; exercised end to end when the cli mounts through the port.
  it.skip('two custom widgets: Tab advances the ring to the FilePicker, whose Enter then dispatches', async () => {
    const { dispatched, stdin, handle } = mountTwoWidgets();
    await tick();
    stdin.write('\r'); // OrderList focused; no dispatch yet
    await tick();
    expect(dispatched).toHaveLength(0);
    stdin.write('\t'); // Tab -> the ring moves to FilePicker
    await tick();
    stdin.write('\r'); // Enter -> the FOCUSED FilePicker emits('change') -> gated dispatch
    await tick();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.elementKey).toBe('fp');
    handle.unmount();
  });

  // Native render-local proto tripwire: an agent-emitted `setState` is render-local — it bypasses
  // the permission gate and reaches json-render's native store built-in with the statePath taken RAW from
  // agent params (minitui runs no zod check on the omitted-handler path). A malicious `/__proto__/...`
  // statePath must NOT pollute the global prototype. Safety today rests on json-render's copy semantics
  // (immutableSetByPath); this is the positive control that reds if a future adapter swap loses it.
  it('render-local setState with a __proto__ statePath does not pollute the global prototype', async () => {
    const stateCatalog = makeCatalog({
      id: 'state',
      components: { Button: { trustTier: 'interactive' } },
      actions: {
        setState: {
          kind: 'render-local',
          params: z.object({ statePath: z.string(), value: z.unknown() }),
        },
      },
    });
    const evilSpec: AppSpec = {
      root: 'btn',
      elements: {
        btn: {
          type: 'Button',
          props: { label: 'go' },
          on: {
            press: {
              action: 'setState',
              params: { statePath: '/__proto__/polluted', value: 'PWNED' },
            },
          },
        },
      },
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec: evilSpec,
      catalog: stateCatalog,
      binding: createInkBinding(stateCatalog),
      dispatcher: { dispatch: async () => ({ status: 'settled' as const }) },
      store: controlledIo({}),
      consent: noopConsent,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick(); // Button auto-focuses
    stdin.write('\r'); // Enter -> emit('press') -> native render-local setState with the evil statePath
    await tick();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    handle.unmount();
  });

  it('allow: an allowed outcome runs exec and emits started then result', async () => {
    const { dispatched, lifecycle, handle } = harness({ status: 'settled', result: 'ok' });
    await handle.fireAction('btn', 'press');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.elementKey).toBe('btn');
    expect(lifecycle).toEqual(['started', 'result']);
    handle.unmount();
  });

  it('deny: a denied outcome blocks exec and emits started then error', async () => {
    const { dispatched, lifecycle, handle } = harness({ status: 'denied', reason: 'nope' });
    await handle.fireAction('btn', 'press');
    expect(dispatched).toHaveLength(1); // the dispatcher was asked, and it denied
    expect(lifecycle).toEqual(['started', 'error']);
    handle.unmount();
  });

  // The mounted app's app-shell key binding (when no consent modal is up) calls onQuit on `q` and
  // onCancel on Esc; the host maps those to a clean-completion / cancelled quit.
  const textCatalog = makeCatalog({
    id: 'display',
    components: { Text: { trustTier: 'display' } },
  });
  const textSpec: AppSpec = {
    root: 't',
    elements: { t: { type: 'Text', props: { value: 'done' } } },
  };
  const okDispatch: ActionDispatcher = { dispatch: async () => ({ status: 'settled' as const }) };

  it('display-only app: `q` fires onQuit, Esc fires onCancel', async () => {
    let quit = 0;
    const onQuit = (): void => {
      quit++;
    };
    let cancel = 0;
    const onCancel = (): void => {
      cancel++;
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec: textSpec,
      catalog: textCatalog,
      binding: createInkBinding(textCatalog),
      dispatcher: okDispatch,
      store: controlledIo({}),
      consent: noopConsent,
      onQuit,
      onCancel,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick();
    stdin.write('q'); // no interactive widget -> `q` quits (completed)
    await tick();
    stdin.write('\x1B'); // Esc -> cancels
    await tick();
    expect(quit).toBe(1);
    expect(cancel).toBe(1);
    handle.unmount();
  });

  it('a focused non-text interactive widget (Button) STILL lets `q` quit', async () => {
    // A focused Button does not capture FREE TEXT, so `q` stays a clean quit — the reading is
    // free-text-capture, not "any interactive widget suppresses q".
    let quit = 0;
    const onQuit = (): void => {
      quit++;
    };
    let cancel = 0;
    const onCancel = (): void => {
      cancel++;
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec,
      catalog,
      binding: createInkBinding(catalog),
      dispatcher: okDispatch,
      store: controlledIo({ inputs: ['a.mp4'] }),
      consent: noopConsent,
      onQuit,
      onCancel,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick(); // Button auto-focuses; reports capturesText:false
    stdin.write('q'); // focused Button does NOT capture text -> `q` quits
    await tick();
    expect(quit).toBe(1);
    stdin.write('\x1B'); // Esc -> cancels
    await tick();
    expect(cancel).toBe(1);
    handle.unmount();
  });

  it('a focused free-text widget (FilePicker) keeps `q` literal (no quit); Esc still cancels', async () => {
    // A FilePicker (capturesText:true) auto-focuses; its focused handler consumes typed characters, so
    // `q` is literal input there and must NOT quit — the shell reads the focused element's capturesText
    // off the binding (fed by the real focus channel), not a spec-wide interactive scan.
    let quit = 0;
    const onQuit = (): void => {
      quit++;
    };
    let cancel = 0;
    const onCancel = (): void => {
      cancel++;
    };
    const fileCatalog = makeCatalog({
      id: 'file',
      components: { FilePicker: { trustTier: 'interactive', capturesText: true } },
      actions: {
        pick: {
          kind: 'exec-local',
          params: z.object({}),
          permission: { danger: false, resourceTemplate: 'pick', summaryTemplate: 'pick' },
        },
      },
    });
    const fileSpec: AppSpec = {
      root: 'fp',
      elements: {
        fp: {
          type: 'FilePicker',
          props: { label: 'out', value: '' },
          on: { change: { action: 'pick', params: {} } },
        },
      },
    };
    const stdin = new FakeStdin();
    const handle = mountInk({
      spec: fileSpec,
      catalog: fileCatalog,
      binding: createInkBinding(fileCatalog),
      dispatcher: okDispatch,
      store: controlledIo({ out: '' }),
      consent: noopConsent,
      onQuit,
      onCancel,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick(); // FilePicker auto-focuses -> reports capturesText:true
    stdin.write('q'); // focused free-text field -> `q` is literal input, NOT a quit
    await tick();
    expect(quit).toBe(0);
    stdin.write('\x1B'); // Esc -> cancels (the picker ignores Esc; the shell owns it)
    await tick();
    expect(cancel).toBe(1);
    handle.unmount();
  });

  it('a consent modal up suppresses the quit key (the overlay owns Esc = deny)', async () => {
    let quit = 0;
    const onQuit = (): void => {
      quit++;
    };
    const stdin = new FakeStdin();
    const pendingConsent: ConsentController = {
      request: {
        id: 'p1',
        descriptor: { danger: false, resourceTemplate: 'x', summaryTemplate: 's' },
        resolvedCommand: 'x',
        resolvedPaths: [],
      } satisfies PermissionRequest,
      subscribe: () => () => {},
      resolve: () => {},
    };
    const handle = mountInk({
      spec: textSpec,
      catalog: textCatalog,
      binding: createInkBinding(textCatalog),
      dispatcher: okDispatch,
      store: controlledIo({}),
      consent: pendingConsent,
      onQuit,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      },
    });
    await tick();
    stdin.write('\x1B'); // Esc while consent is up -> quit suppressed
    stdin.write('q');
    await tick();
    expect(quit).toBe(0);
    handle.unmount();
  });
});
