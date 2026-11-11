import { hostCatalogDeps, videoMergeCatalog } from '@minitui/catalog';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { createInkBinding, createInkRenderer, type ConsentController } from '@minitui/renderer-ink';
import { createAppHost, type HostSession } from '@minitui/runtime-host';
import type { MiniAppSpec } from '@minitui/spec';
import {
  FakeStdin,
  FakeStdout,
  asReadStream,
  asWriteStream,
  keyBytes,
  waitFor,
} from '@minitui/test-kit';
import { createDataStore, type DataStore } from '@minitui/transport';
import { JsonObjectSchema } from '@minitui/types';
import { focusMerge, type Drivable } from './focus.js';

type RendererStore = Parameters<typeof createInkRenderer>[0]['store'];

/**
 * The renderer's view of the shared store: the snapshot object stays the same until the store changes,
 * because the renderer's store subscription compares snapshots by identity.
 */
function rendererStore(store: DataStore): RendererStore {
  let source = store.getState();
  let snapshot: Record<string, unknown> = JsonObjectSchema.parse(source);
  return {
    getSnapshot: () => {
      const current = store.getState();
      if (current !== source) {
        snapshot = JsonObjectSchema.parse(current);
        source = current;
      }
      return snapshot;
    },
    setSnapshot: (next) => store.applySnapshot(JsonObjectSchema.parse(next)),
    subscribe: (listener) => store.subscribe(() => listener()),
  };
}

const NO_CONSENT: ConsentController = {
  request: undefined,
  subscribe: () => () => undefined,
  resolve: () => undefined,
};

export interface InkUnderHost extends Drivable {
  readonly session: HostSession;
  /** Moves the focus to the Merge button one Tab at a time, waiting for each move to render. */
  focusMerge(): Promise<void>;
}

/**
 * The runtime host over the real Ink renderer, drawn into a fake terminal, with the catalog's own
 * lookups and the dispatcher a row gives it.
 */
export async function inkUnderHost(args: {
  readonly spec: MiniAppSpec;
  readonly dispatcher: ActionDispatcher;
  readonly consent?: ConsentController;
}): Promise<InkUnderHost> {
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const stdin = new FakeStdin();
  const store = createDataStore();
  const renderer = createInkRenderer({
    catalog: videoMergeCatalog,
    store: rendererStore(store),
    consent: args.consent ?? NO_CONSENT,
    io: {
      stdout: asWriteStream(stdout),
      stderr: asWriteStream(stderr),
      stdin: asReadStream(stdin),
      debug: true,
    },
  });
  const host = createAppHost({
    renderer,
    binding: createInkBinding(videoMergeCatalog),
    dispatcher: args.dispatcher,
    store,
    ...hostCatalogDeps(videoMergeCatalog),
  });
  const session = await host.mount(args.spec);
  await waitFor(() => stdout.frames.length > 0, 'the first frame');
  const frame = (): string => stdout.frames.at(-1) ?? '';
  const press = async (key: string): Promise<void> => {
    stdin.write(keyBytes(key));
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
  };
  return { session, frame, press, focusMerge: () => focusMerge({ frame, press }) };
}
