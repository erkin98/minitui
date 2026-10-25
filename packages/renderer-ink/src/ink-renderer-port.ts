import type React from 'react';
import type { StoreAdapterConfig } from '@json-render/core';
import type { RenderHandle, RendererPort, WidgetCatalogBinding } from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import {
  mountInk,
  assertSpecOnCatalog,
  makeOffCatalogFallback,
  type MountInkArgs,
} from './mount.js';
import { RendererRefusal } from './refusal.js';
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
  // Ink-only seams, forwarded verbatim to the mount: the streams ink renders to (a test hands fakes;
  // without them a mount writes to the real terminal) and the ink render entry.
  readonly io?: MountInkArgs['io'];
  readonly renderInk?: MountInkArgs['renderInk'];
  readonly diagnostics?: MountInkArgs['diagnostics'];
}

export type PortMountArgs = Parameters<RendererPort['mount']>[0];

// A resolved factory of the port's binding is `unknown` until it is checked: a React component is a
// function, or an exotic component object (memo, forwardRef) that carries a $$typeof tag.
function isComponent(value: unknown): value is React.ComponentType<WidgetProps> {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  );
}

// The port hands the binding over with its factory type unknown. This narrows it by checking each
// factory at the moment it is resolved; a factory that is not a component resolves to nothing,
// which the mount then refuses like any other unbound component.
function inkBinding(
  binding: WidgetCatalogBinding,
): WidgetCatalogBinding<React.ComponentType<WidgetProps>> {
  return {
    catalogId: binding.catalogId,
    resolve(componentId) {
      const resolved = binding.resolve(componentId);
      if (resolved === undefined || !isComponent(resolved.factory)) return undefined;
      return { ...resolved, factory: resolved.factory };
    },
  };
}

// The mount of the port, typed against the port's own argument type. It is a standalone function so
// that a test can compare it with strict parameter types (the port interface declares a method, which
// TypeScript compares loosely).
export function inkMount(deps: InkRendererDeps): (args: PortMountArgs) => Promise<RenderHandle> {
  // eslint-disable-next-line @typescript-eslint/require-await -- the port contract is Promise-returning while the ink mount is synchronous; async keeps a pre-render assert failure surfacing as a rejection, never a sync throw across the boundary
  return async (args) => {
    // The store is controlled and the library ignores initialState when a store is passed, so there is
    // nothing to forward it to: refuse it rather than drop it. null counts as defined.
    if (args.initialState !== undefined) {
      throw new RendererRefusal(
        'initial-state-unsupported',
        'the Ink renderer does not accept initialState: its store is controlled',
      );
    }
    // mountInk returns the extended ink handle (test-only inspection members included);
    // typing the return as Promise<RenderHandle> narrows it to the port surface, so no
    // production consumer ever sees more than the swap boundary's contract.
    return mountInk({
      spec: args.spec,
      catalog: deps.catalog,
      binding: inkBinding(args.binding),
      dispatcher: args.dispatcher,
      store: deps.store,
      onLifecycle: args.onLifecycle,
      consent: deps.consent,
      accessible: args.accessible,
      onQuit: args.onQuit,
      onCancel: args.onCancel,
      io: deps.io,
      renderInk: deps.renderInk,
      diagnostics: deps.diagnostics,
    });
  };
}

// The renderer-port factory the CLI composition root injects. The Ink-only dependencies
// (catalog / store io / consent) close over the factory here; binding, accessibility, and the
// quit/cancel outlets flow through `mount` itself — so the port surface stays renderer-agnostic
// (no React, Ink, or json-render type appears on it). The store crosses this seam as the RAW
// { getSnapshot; setSnapshot; subscribe } io, never a pre-built StateStore: building the store
// adapter inside renderer-ink keeps every @json-render import on this side of the boundary, and
// a built StateStore has no whole-snapshot writer so it could not back applyStatePatch anyway.
export function createInkRenderer(deps: InkRendererDeps): RendererPort {
  return { mount: inkMount(deps) };
}
