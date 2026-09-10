import { describe, it, expect } from 'vitest';
import { sanitize, sanitizeSpecStrings } from '../src/sanitize/index.js';
import type { ActionBinding, AppSpec, SpecElement } from '../src/contract/spec.js';

const ESC = '\x1b';

describe('sanitize re-export (bind-time entry)', () => {
  it('strips a control sequence via the leaf', () => {
    expect(sanitize(`a${ESC}[31mb`)).not.toContain(ESC);
  });
  it('sanitizeSpecStrings returns a cleaned spec object', () => {
    const out = sanitizeSpecStrings({ x: `a${ESC}[31mb` });
    expect(out.x).not.toContain(ESC);
  });
});

describe('spec vocabulary re-export', () => {
  it('AppSpec/SpecElement/ActionBinding are usable as the catalog spec types', () => {
    const press: ActionBinding = {
      action: 'setState',
      params: { statePath: '/count', value: 1 },
    };
    const el: SpecElement = { type: 'Box', props: {}, on: { press } };
    const spec: AppSpec = { root: 'a', elements: { a: el } };
    expect(spec.root).toBe('a');
    expect(el.on?.press).toBe(press);
  });
});
