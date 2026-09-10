import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '../src/define-catalog.js';
import { buildCatalogPrompt } from '../src/prompt.js';

const cat = defineMinituiCatalog({
  id: 'demo',
  components: {
    Button: {
      props: z.object({ label: z.string() }).strict(),
      slots: [],
      description: 'btn',
      trustTier: 'interactive',
    },
  },
  actions: {
    merge: {
      params: z.object({}),
      description: 'Merge videos',
      kind: 'exec-local',
      permission: {
        danger: true,
        resourceTemplate: 'ffmpeg',
        summaryTemplate: 'Merge two videos with ffmpeg',
      },
    },
    setState: {
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'Update state',
      kind: 'render-local',
    },
  },
});

describe('buildCatalogPrompt', () => {
  it('includes the adopted base catalog prompt body', () => {
    const out = buildCatalogPrompt(cat);
    // the base prompt documents component names
    expect(out).toContain('Button');
  });
  it('appends a danger hint for the exec-local action with its summary', () => {
    const out = buildCatalogPrompt(cat);
    expect(out).toMatch(/merge/);
    expect(out).toContain('Merge two videos with ffmpeg');
    expect(out.toLowerCase()).toContain('danger');
  });
  it('notes the render-local STATE-only action carries no gate', () => {
    const out = buildCatalogPrompt(cat);
    // Bind the name TO the classification: this substring is emitted only by the
    // per-action render-local line, never by the static "setState/pushState/
    // removeState" reminder — so it fails if setState is classified as gated.
    expect(out).toContain('setState: render-local');
  });
  it('threads custom rules through to the base prompt', () => {
    const out = buildCatalogPrompt(cat, { customRules: ['NEVER use emojis.'] });
    expect(out).toContain('NEVER use emojis.');
  });
});
