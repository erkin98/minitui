import { describe, it, expect } from 'vitest';
import { externalBundledInputs } from '../scripts/runtime-leaf.mjs';

// Positive control for the build-time bundle-leak gate: prove the predicate that
// check-runtime-leaf.mjs runs can actually fire on a leaked input.
describe('runtime-leaf bundle gate predicate', () => {
  it('flags a metafile input that came from node_modules', () => {
    const leaked = { inputs: { 'src/index.ts': {}, 'node_modules/evil/index.js': {} } };
    expect(externalBundledInputs(leaked)).toEqual(['node_modules/evil/index.js']);
  });

  it('passes a clean relative-only bundle', () => {
    expect(externalBundledInputs({ inputs: { 'src/index.ts': {}, 'src/osc.ts': {} } })).toEqual([]);
  });

  it('is total on a missing inputs map', () => {
    expect(externalBundledInputs({})).toEqual([]);
  });
});
