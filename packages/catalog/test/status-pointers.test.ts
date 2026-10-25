import { describe, it, expect } from 'vitest';
import type { JsonValue } from '@minitui/types';
import { buildCatalogPrompt, videoMergeCatalog, type AppSpec } from '../src/index.js';
import { checkSemantics } from '../src/validate/semantic.js';

const mergeSpec: AppSpec = {
  root: 'go',
  elements: {
    go: {
      type: 'Button',
      props: { label: 'Merge' },
      on: {
        press: {
          action: 'merge',
          params: {
            inputs: { $state: '/inputs' },
            codec: { $state: '/codec' },
            output: { $state: '/output' },
          },
        },
      },
    },
  },
};

const seeded = {
  inputs: ['/abs/a.mp4', '/abs/b.mp4'],
  codec: 'h264',
  output: '/abs/out.mp4',
  merge: { progress: 0, status: '' },
};

const bindingMessages = (state: JsonValue): string[] =>
  checkSemantics(mergeSpec, videoMergeCatalog, state)
    .filter((issue) => issue.code === 'bad-binding')
    .map((issue) => issue.message);

describe('the status pointers of a gated action', () => {
  it('merge declares its two status pointers', () => {
    expect(videoMergeCatalog.actionDefs.get('merge')?.statusPointers).toEqual({
      progress: '/merge/progress',
      status: '/merge/status',
    });
  });

  it('a spec whose state seeds both pointers passes', () => {
    expect(bindingMessages(seeded)).toEqual([]);
  });

  it('is refused, naming both pointers, when the state does not seed them', () => {
    const { merge: _unseeded, ...rest } = seeded;
    const messages = bindingMessages(rest);
    expect(messages.some((message) => message.includes('"/merge/progress"'))).toBe(true);
    expect(messages.some((message) => message.includes('"/merge/status"'))).toBe(true);
  });

  it('is refused when a pointer holds the wrong type', () => {
    const progress = bindingMessages({ ...seeded, merge: { progress: '0', status: '' } });
    expect(progress.some((message) => message.includes('"/merge/progress"'))).toBe(true);
    const status = bindingMessages({ ...seeded, merge: { progress: 0, status: 5 } });
    expect(status.some((message) => message.includes('"/merge/status"'))).toBe(true);
  });

  it('the prompt names both pointers', () => {
    expect(buildCatalogPrompt(videoMergeCatalog)).toContain(
      'are written at: /merge/progress, /merge/status',
    );
  });
});
