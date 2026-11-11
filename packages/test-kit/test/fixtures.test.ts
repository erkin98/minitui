import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runFullValidation, videoMergeCatalog, type AppSpec } from '@minitui/catalog';
import { composeValidation, type CapabilityProvider } from '@minitui/spec';
import type { JsonValue } from '@minitui/types';
import {
  MERGE_SPEC,
  MERGE_RUN,
  MERGE_TOOL_OK,
  MERGE_TOOL_FAIL,
  SPEC_FILES,
  specPatchText,
} from '../src/fixtures/merge-task.fixtures.js';

// Every file exists and every codec is supported: the rows below test the spec, not the machine.
const capabilities: CapabilityProvider = {
  listEncoders: () => Promise.resolve(['libx264']),
  listCodecs: () => Promise.resolve(['h264']),
  listFilters: () => Promise.resolve([]),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

async function* once(text: string): AsyncIterable<string> {
  await Promise.resolve();
  yield text;
}

// The text the model loop would stream: every text chunk of MERGE_RUN, in order.
const runText = (): string =>
  MERGE_RUN.chunks()
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');

describe('merge fixtures', () => {
  it('MERGE_SPEC is a keyed-map spec with a resolvable root and a state model', () => {
    expect(MERGE_SPEC.root).toBe('screen');
    expect(MERGE_SPEC.elements[MERGE_SPEC.root]).toBeDefined();
    expect(MERGE_SPEC.state).toHaveProperty('inputs');
  });

  it('binds the merge action under on.press with $state params, never in props', () => {
    const button = MERGE_SPEC.elements['merge'];
    if (!button) throw new Error('fixture element missing: merge');
    expect(button.props).not.toHaveProperty('action');
    expect(button.on?.press).toMatchObject({
      action: 'merge',
      params: { inputs: { $state: '/inputs' }, output: { $state: '/output' } },
    });
  });

  it('uses absolute paths and the stream-copy codec, as the real model writes them', () => {
    expect(MERGE_SPEC.state).toMatchObject({
      inputs: ['/videos/a.mp4', '/videos/b.mp4'],
      codec: 'copy',
      output: '/videos/out.mp4',
    });
  });

  it('MERGE_RUN is the spec as text and a finish: the model never calls a tool', () => {
    expect(MERGE_RUN.chunks().map((c) => c.type)).toEqual(['text', 'finish']);
    expect(runText()).toBe(specPatchText(MERGE_SPEC));
  });

  it("MERGE_RUN's text passes the real validation loop and yields MERGE_SPEC", async () => {
    const result = await composeValidation({
      stream: once(runText()),
      catalog: videoMergeCatalog,
      capabilities,
      regenerate: () => once(''),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec).toEqual(MERGE_SPEC);
  });

  // The loop checks the spec against the catalog; it does not check that paths are absolute (exec
  // refuses a relative path at dispatch, which is why MERGE_SPEC uses absolute ones).
  it('the same text with an off-catalog component fails the same loop', async () => {
    const offCatalog = runText().replace('"type":"Button"', '"type":"ArbitraryHtml"');
    expect(offCatalog).not.toBe(runText());
    const result = await composeValidation({
      stream: once(offCatalog),
      catalog: videoMergeCatalog,
      capabilities,
      regenerate: () => once(offCatalog),
    });
    expect(result.ok).toBe(false);
  });

  it('the committed valid spec file holds exactly MERGE_SPEC', () => {
    const fromFile: unknown = JSON.parse(readFileSync(SPEC_FILES.validMergeBasic, 'utf8'));
    expect(fromFile).toEqual(MERGE_SPEC);
  });

  it('exposes a success and a failure tool outcome', () => {
    expect(MERGE_TOOL_OK.lifecycle.at(-1)?.phase).toBe('result');
    expect(MERGE_TOOL_FAIL.lifecycle.at(-1)?.phase).toBe('error');
  });

  it('the committed valid spec passes the catalog and each invalid one fails with its own code', () => {
    // A committed file read from disk, parsed into the typed variable (no cast).
    const load = (path: string): AppSpec & { readonly state: JsonValue } =>
      JSON.parse(readFileSync(path, 'utf8'));
    const valid = load(SPEC_FILES.validMergeBasic);
    expect(runFullValidation(valid, videoMergeCatalog, valid.state)).toEqual({ ok: true });
    for (const [path, code] of [
      [SPEC_FILES.invalidUnknownComponent, 'unknown-component'],
      [SPEC_FILES.invalidDanglingBinding, 'bad-binding'],
    ] as const) {
      const spec = load(path);
      const result = runFullValidation(spec, videoMergeCatalog, spec.state);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toContain(code);
    }
  });
});
