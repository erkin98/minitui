import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { assertSpecOnCatalog, makeOffCatalogFallback } from '../src/ink-renderer-port.js';
import type { AppSpec } from '@minitui/types';
import { makeCatalog } from './support/make-catalog.js';

const catalog = makeCatalog({
  components: { Text: { trustTier: 'display' } },
  actions: { setState: { kind: 'render-local' } },
});

describe('off-catalog enforcement (pre-render assert + loud fallback)', () => {
  it('assertSpecOnCatalog throws naming an off-catalog component', () => {
    const spec: AppSpec = { root: 'e', elements: { e: { type: 'EvilWidget', props: {} } } };
    expect(() => assertSpecOnCatalog(spec, catalog)).toThrow(/EvilWidget.*catalog allowlist/i);
  });

  it('assertSpecOnCatalog throws naming an off-catalog on/watch action', () => {
    const spec: AppSpec = {
      root: 't',
      elements: { t: { type: 'Text', props: {}, on: { press: { action: 'formatDisk' } } } },
    };
    expect(() => assertSpecOnCatalog(spec, catalog)).toThrow(/formatDisk.*not in the catalog/i);
  });

  it('assertSpecOnCatalog passes a clean spec', () => {
    const spec: AppSpec = {
      root: 't',
      elements: {
        t: { type: 'Text', props: {}, on: { press: { action: 'setState', params: {} } } },
      },
    };
    expect(() => assertSpecOnCatalog(spec, catalog)).not.toThrow();
  });

  it('the fallback renders a LOUD red marker naming the type (defense-in-depth, not a throw)', () => {
    const Fallback = makeOffCatalogFallback();
    const { lastFrame } = render(
      React.createElement(Fallback, { element: { type: 'EvilWidget' } }),
    );
    expect(lastFrame()).toContain('[off-catalog: EvilWidget]');
  });
});
