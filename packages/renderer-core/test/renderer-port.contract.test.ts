import { describe, it, expect } from 'vitest';
import type { RendererPort, RenderHandle } from '../src/renderer-port.js';
import type { AppSpec, JsonPatch, ActionRequest } from '@minitui/types';

describe('RendererPort / RenderHandle', () => {
  it('the module resolves as a valid ESM module', async () => {
    // The port is type-only, so a static `import type` erases at runtime and cannot
    // witness the file's existence. A dynamic import is not erased: it rejects until
    // src/renderer-port.ts exists, then resolves to the module namespace. (renderer-port's
    // own imports are all type-only too, so this resolves even before the dispatch/events
    // sibling files land.)
    const mod = await import('../src/renderer-port.js');
    expect(mod).toBeDefined();
  });

  it('mount returns a RenderHandle with update/applyStatePatch/onAction/unmount', async () => {
    const calls: string[] = [];
    const handlers: Array<(r: ActionRequest) => void> = [];

    const port: RendererPort = {
      async mount(args) {
        calls.push(`mount:${args.spec.root}`);
        const handle: RenderHandle = {
          update: () => calls.push('update'),
          applyStatePatch: (patch: readonly JsonPatch[]) => calls.push(`patch:${patch.length}`),
          onAction: (h) => {
            handlers.push(h);
            return () => calls.push('unsub');
          },
          unmount: () => calls.push('unmount'),
        };
        return handle;
      },
    };

    const spec: AppSpec = { root: 'r', elements: {} }; // complete state-free AppSpec (§B7/§G7) — no cast needed
    const handle = await port.mount({
      spec,
      binding: { catalogId: 'c', resolve: () => undefined },
      dispatcher: { dispatch: async () => ({ status: 'settled' }) },
      initialState: {},
    });

    handle.update(spec);
    handle.applyStatePatch([{ op: 'replace', path: '/a', value: 1 }]); // contextually typed as readonly JsonPatch[] — no cast
    const unsub = handle.onAction(() => {});
    unsub();
    handle.unmount();

    expect(calls).toEqual(['mount:r', 'update', 'patch:1', 'unsub', 'unmount']);
    expect(handlers).toHaveLength(1);
  });
});
