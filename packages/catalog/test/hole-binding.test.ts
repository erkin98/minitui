import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { JsonValue } from '@minitui/types';
import { defineMinituiCatalog, videoMergeCatalog, type AppSpec } from '../src/index.js';
import { checkSemantics } from '../src/validate/semantic.js';

const press = (action: string, params: Record<string, JsonValue>): AppSpec => ({
  root: 'go',
  elements: {
    go: { type: 'Button', props: { label: 'Go' }, on: { press: { action, params } } },
  },
});

const state: JsonValue = {
  inputs: ['/abs/a.mp4', '/abs/b.mp4'],
  codec: 'h264',
  output: '/abs/out.mp4',
  pick: true,
  merge: { progress: 0, status: '' },
};

const bindingMessages = (spec: AppSpec, against: JsonValue = state): string[] =>
  checkSemantics(spec, videoMergeCatalog, against)
    .filter((issue) => issue.code === 'bad-binding')
    .map((issue) => issue.message);

const bound = {
  inputs: { $state: '/inputs' },
  codec: { $state: '/codec' },
  output: { $state: '/output' },
};

describe('a param named by a template hole is bound to its state root', () => {
  it('passes when every such param is bound to its own root', () => {
    expect(bindingMessages(press('merge', bound))).toEqual([]);
  });

  it.each([
    ['a literal output', 'output', { ...bound, output: '/abs/out.mp4' }],
    ['a literal list of inputs', 'inputs', { ...bound, inputs: ['/abs/a.mp4', '/abs/b.mp4'] }],
    [
      'a conditional codec',
      'codec',
      { ...bound, codec: { $cond: { $state: '/pick' }, $then: 'h264', $else: 'vp9' } },
    ],
    ['an output bound to another root', 'output', { ...bound, output: { $state: '/codec' } }],
    ['a two-way codec binding', 'codec', { ...bound, codec: { $bindState: '/codec' } }],
    ['a marker with an extra key', 'codec', { ...bound, codec: { $state: '/codec', note: 'x' } }],
  ])('refuses %s and names the param', (_name, param, params) => {
    const messages = bindingMessages(press('merge', params));
    expect(messages.some((message) => message.includes(`"${param}"`))).toBe(true);
  });

  it('leaves an absent param to the params check', () => {
    const { output: _absent, ...rest } = bound;
    expect(bindingMessages(press('merge', rest))).toEqual([]);
  });
});

describe('the holes of the summary template are checked', () => {
  const notes = defineMinituiCatalog({
    id: 'notes',
    components: {
      Button: {
        props: z.object({ label: z.string() }).strict(),
        slots: [],
        description: 'btn',
        trustTier: 'interactive',
      },
    },
    actions: {
      note: {
        params: z.object({ text: z.string() }),
        description: 'note',
        kind: 'exec-local',
        permission: {
          danger: false,
          resourceTemplate: 'note',
          summaryTemplate: 'Note ${/missing}',
        },
      },
    },
  });
  const issuesFor = (against: JsonValue) =>
    checkSemantics(press('note', { text: 'hi' }), notes, against).filter(
      (issue) => issue.code === 'bad-binding',
    );

  it('refuses a summary hole that does not resolve to text', () => {
    const messages = issuesFor({}).map((issue) => issue.message);
    expect(messages.some((m) => m.includes('summaryTemplate') && m.includes('/missing'))).toBe(
      true,
    );
  });

  it('passes when the summary hole resolves', () => {
    expect(issuesFor({ missing: 'here' })).toEqual([]);
  });
});
