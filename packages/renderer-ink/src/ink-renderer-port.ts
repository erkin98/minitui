import type React from 'react';
import type { AppSpec } from '@minitui/types';
import type {
  ActionDispatcher,
  LifecycleEmitter,
  RenderHandle,
  RendererPort,
  WidgetCatalogBinding,
} from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import type { StoreAdapterConfig } from '@json-render/core';
import { mountInk, assertSpecOnCatalog, makeOffCatalogFallback } from './mount.js';
import type { ConsentController } from './widgets/consent-overlay.js';
import type { WidgetProps } from './widgets/command-preview.js';

// Both enforcement pieces are DEFINED in mount.tsx (where they are wired into the LIVE mount
// path). Re-export here so consumers + the enforcement unit test import from one place;
// defining them in mount.tsx (not here) avoids a port->mount->port import cycle.
export { assertSpecOnCatalog, makeOffCatalogFallback };

export interface InkRendererDeps {
  readonly catalog: MinituiCatalog;
  readonly store: StoreAdapterConfig; // raw { getSnapshot; setSnapshot; subscribe } io over the transport data store
  readonly consent: ConsentController;
}

// The renderer-port factory the CLI composition root injects. The Ink-only dependencies
// (catalog / store io / consent) close over the factory here; binding, accessibility, and the
// quit/cancel outlets flow through `mount` itself — so the port surface stays renderer-agnostic
// (no React, Ink, or json-render type appears on it). The store crosses this seam as the RAW
// { getSnapshot; setSnapshot; subscribe } io, never a pre-built StateStore: building the store
// adapter inside renderer-ink keeps every @json-render import on this side of the boundary, and
// a built StateStore has no whole-snapshot writer so it could not back applyStatePatch anyway.
export function createInkRenderer(deps: InkRendererDeps): RendererPort {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- the port contract is Promise-returning while the ink mount is synchronous; async keeps a pre-render assert failure surfacing as a rejection, never a sync throw across the boundary
    async mount(args: {
      spec: AppSpec;
      binding: WidgetCatalogBinding<React.ComponentType<WidgetProps>>;
      dispatcher: ActionDispatcher;
      onLifecycle?: LifecycleEmitter | undefined;
      accessible?: boolean | undefined;
      onQuit?: (() => void) | undefined; // app-shell `q` clean-quit outlet, forwarded verbatim
      onCancel?: (() => void) | undefined; // app-shell Esc cancel outlet, forwarded verbatim
    }): Promise<RenderHandle> {
      // mountInk returns the extended ink handle (test-only inspection members included);
      // typing the return as Promise<RenderHandle> narrows it to the port surface, so no
      // production consumer ever sees more than the swap boundary's contract.
      return mountInk({
        spec: args.spec,
        catalog: deps.catalog,
        binding: args.binding,
        dispatcher: args.dispatcher,
        store: deps.store,
        onLifecycle: args.onLifecycle,
        consent: deps.consent,
        accessible: args.accessible,
        onQuit: args.onQuit,
        onCancel: args.onCancel,
      });
    },
  };
}
