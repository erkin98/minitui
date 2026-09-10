import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { JSONUIProvider } from '@json-render/ink';
import { createInkBinding, OrderList } from '../src/widgets/bindings.js';
import { CommandPreview } from '../src/widgets/command-preview.js'; // host chrome — barrel-direct, NOT via bindings
import { makeCatalog } from './support/make-catalog.js';

const catalog = makeCatalog({
  id: 'video-merge',
  components: {
    Text: { trustTier: 'display' },
    Button: { trustTier: 'interactive' },
    OrderList: { trustTier: 'interactive' },
    FilePicker: { trustTier: 'interactive', capturesText: true }, // free-text widget → capturesText surfaced through resolve()
    CommandPreview: { trustTier: 'display' }, // declared here ONLY to prove the binding still won't resolve it
  },
});

// useBoundProp needs a StateProvider — wrap interactive widgets the way the live tree does.
function wrap(node: React.ReactElement) {
  return render(<JSONUIProvider>{node}</JSONUIProvider>);
}

describe('createInkBinding', () => {
  it('resolves the Button CTA with its interactive trust tier', () => {
    const r = createInkBinding(catalog).resolve('Button');
    expect(r?.trustTier).toBe('interactive');
    expect(typeof r?.factory).toBe('function');
  });

  it('surfaces the catalog capturesText bit on resolve(): FilePicker true, non-text false', () => {
    const binding = createInkBinding(catalog);
    expect(binding.resolve('FilePicker')?.capturesText).toBe(true); // free-text widget
    expect(binding.resolve('Button')?.capturesText).toBe(false); // non-text (default false)
    expect(binding.resolve('Text')?.capturesText).toBe(false); // display default
  });

  it('resolves a custom component with its trust tier', () => {
    const binding = createInkBinding(catalog);
    const r = binding.resolve('OrderList');
    expect(r?.trustTier).toBe('interactive');
    expect(typeof r?.factory).toBe('function');
  });

  it('resolves a std component (Text) from json-render', () => {
    const binding = createInkBinding(catalog);
    expect(binding.resolve('Text')?.factory).toBeDefined();
  });

  it('returns undefined for an unknown id', () => {
    expect(createInkBinding(catalog).resolve('Nope')).toBeUndefined();
  });

  it('does NOT resolve CommandPreview — it is host chrome, out of the agent binding', () => {
    // even with CommandPreview in componentDefs, it is absent from the CUSTOM map + std set, so the
    // agent can never place it through a spec; its mount is a deferred product decision (none is wired yet).
    expect(createInkBinding(catalog).resolve('CommandPreview')).toBeUndefined();
  });

  it('CommandPreview renders the bound resolved command verbatim (no re-resolution)', () => {
    const { lastFrame } = render(
      React.createElement(CommandPreview, {
        element: { type: 'CommandPreview', props: { command: 'ffmpeg -i a.mp4 -i b.mp4 out.mp4' } },
        emit: () => {},
      }),
    );
    expect(lastFrame()).toContain('ffmpeg -i a.mp4 -i b.mp4 out.mp4');
  });

  it('OrderList renders its items in order', () => {
    const { lastFrame } = wrap(
      React.createElement(OrderList, {
        element: { type: 'OrderList', props: { items: ['a.mp4', 'b.mp4'] } },
        emit: () => {},
        bindings: { items: '/inputs' },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame.indexOf('a.mp4')).toBeLessThan(frame.indexOf('b.mp4'));
  });
});
