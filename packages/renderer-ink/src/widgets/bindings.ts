import type { ComponentType } from 'react';
import { standardComponents } from '@json-render/ink';
import type { WidgetCatalogBinding } from '@minitui/renderer-core';
import type { MinituiCatalog } from '@minitui/catalog';
import type { WidgetProps } from './command-preview.js';
import { Button } from './button.js';
import { OrderList } from './order-list.js';
import { FilePicker } from './file-picker.js';
import { ProgressWidget } from './progress.js';

export { Button, OrderList, FilePicker, ProgressWidget };
export type { WidgetProps };

// SPEC string props are sanitized ONCE at mount (the mount-time prepare pass). Agent
// STATE strings are sanitized UPSTREAM at the transport seam BEFORE they reach the
// store — so a state-bound string (including the Markdown widget's live re-lexed text)
// can never carry raw control chars to the screen. This is the security contract: do
// NOT add per-widget sanitize.
// The 4 CUSTOM CATALOG widgets (agent-placeable). CommandPreview is NOT here — it is
// host chrome (exported from the package barrel directly; its mount site is a deferred
// product decision, none is wired yet), so a spec cannot place it.
const CUSTOM: Record<string, ComponentType<WidgetProps>> = {
  Button,
  FilePicker,
  OrderList,
  // Overrides the std ProgressBar on id collision (custom over standard, matching
  // json-render's registry merge) — every planned catalog registers 'ProgressBar',
  // never 'Progress'. Renders a filled/empty block bar and reads the adopted std
  // prop `progress` (not `value`).
  ProgressBar: ProgressWidget,
};

export function createInkBinding(
  catalog: MinituiCatalog,
): WidgetCatalogBinding<ComponentType<WidgetProps>> {
  return {
    catalogId: catalog.id,
    resolve(componentId: string) {
      const def = catalog.componentDefs.get(componentId);
      if (!def) return undefined;
      // custom overrides std on id collision (json-render merges custom over standard)
      const factory =
        CUSTOM[componentId] ??
        (standardComponents as Record<string, ComponentType<WidgetProps>>)[componentId];
      if (!factory) return undefined;
      // Surface the catalog's free-text-capture bit (default false for the display/
      // select/button widgets). The app shell reads it to decide whether the `q` key
      // quits or is literal input.
      return { factory, trustTier: def.trustTier, capturesText: def.capturesText ?? false };
    },
  };
}
