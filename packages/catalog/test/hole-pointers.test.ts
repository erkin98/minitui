import { describe, it, expect } from 'vitest';
import type { JsonValue } from '@minitui/types';
import { checkSemantics, videoMergeCatalog, type AppSpec } from '../src/index.js';
import { holePointersOf } from '../src/contract/action-kind.js';

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

const stateWith = (inputs: JsonValue): JsonValue => ({
  inputs,
  codec: 'h264',
  output: '/abs/out.mp4',
});

const bindingMessages = (state: JsonValue): string[] =>
  checkSemantics(mergeSpec, videoMergeCatalog, state)
    .filter((issue) => issue.code === 'bad-binding')
    .map((issue) => issue.message);

describe('the holes of a resource template are read from the template', () => {
  it('a state value of 64,000 unclosed holes is checked in under 1 s', () => {
    const state = stateWith(['${/'.repeat(64_000), '/abs/b.mp4']);
    const started = performance.now();
    checkSemantics(mergeSpec, videoMergeCatalog, state);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('state text that holds a hole is not read as an unresolved pointer', () => {
    const messages = bindingMessages(stateWith(['/abs/${/nope}.mp4', '/abs/b.mp4']));
    expect(messages.filter((message) => message.includes('/nope'))).toEqual([]);
  });

  it('a hole that resolves to a non-string is still unresolved', () => {
    const messages = bindingMessages(stateWith([{ a: 1 }, '/abs/b.mp4']));
    expect(
      messages.some((message) => message.endsWith('against the bound state: /inputs/0.')),
    ).toBe(true);
  });

  it.each([
    '',
    'x',
    '${/a}',
    'a ${/x} b ${/y/0} ${/z',
    '${/a${/b}',
    '${a}${/b}',
    '${/}',
    '}${/q}{',
  ])('reads the same holes as the hole regex in %j', (template) => {
    const viaRegex = [...template.matchAll(/\$\{(\/[^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(holePointersOf(template)).toEqual(viaRegex);
  });

  it('a template of 512,000 unclosed holes is read in one pass', () => {
    const started = performance.now();
    expect(holePointersOf('${/'.repeat(512_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
