import {
  AgentSession,
  catalogVisibilityToChannel,
  createSpecSink,
  createVisibilityChannel,
  routeRuntimeFault,
  type MinituiEvent,
} from '@minitui/agent-core';
import { CATALOG_REPAIR_WORDING, videoMergeCatalog } from '@minitui/catalog';
import type { ActionDispatcher } from '@minitui/renderer-core';
import { createInkBinding } from '@minitui/renderer-ink';
import {
  composeValidation,
  toRuntimeRepair,
  type CapabilityProvider,
  type MiniAppSpec,
} from '@minitui/spec';
import {
  MERGE_RUN,
  MERGE_SPEC,
  MERGE_TOOL_FAIL,
  MERGE_TOOL_OK,
  createMockPermissionEngine,
  createMockToolRegistry,
  matchGolden,
  mountHeadless,
  type MockLlmProvider,
} from '@minitui/test-kit';
import type { RuntimeFault } from '@minitui/types';
import { describe, expect, it } from 'vitest';
import { inkUnderHost } from './support/ink-under-host.js';

// The merge spine end to end, headless: the scripted model reply leaves a real agent session as text, the
// real validation loop turns it into the app, the real Ink renderer mounts it, a key press reaches the
// consent box, and the merge runs to done. A failed merge goes back to the same session as a repair turn.
const GOLDEN_DIR = new URL('./__golden__/', import.meta.url);

const capabilities: CapabilityProvider = {
  listCodecs: () => Promise.resolve(['h264']),
  listEncoders: () => Promise.resolve(['libx264']),
  listFilters: () => Promise.resolve(['concat']),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

async function* neverAsked(): AsyncGenerator<string> {
  yield* [];
  throw new Error('the loop asked for a regeneration');
}

function scriptedSession(provider: MockLlmProvider): AgentSession {
  return new AgentSession({
    provider,
    toolDispatch: {
      dispatch: (req) => Promise.reject(new Error(`the model called a tool: ${req.toolName}`)),
    },
    specSink: createSpecSink(),
    visibility: createVisibilityChannel(catalogVisibilityToChannel(videoMergeCatalog)),
    tools: [],
    model: 'scripted',
  });
}

async function textOf(
  events: AsyncGenerator<MinituiEvent>,
): Promise<{ text: string; types: string[] }> {
  let text = '';
  const types: string[] = [];
  for await (const event of events) {
    types.push(event.type);
    if (event.type === 'TEXT_MESSAGE_CONTENT') text += event.delta;
  }
  return { text, types };
}

async function validated(text: string): Promise<MiniAppSpec> {
  const result = await composeValidation({
    stream: once(text),
    catalog: videoMergeCatalog,
    capabilities,
    regenerate: () => neverAsked(),
  });
  if (!result.ok) throw new Error('the validation loop refused the reply');
  return result.spec;
}

describe('the merge spine', () => {
  it('the reply becomes the app, a press asks for consent, and the merge runs to done', async () => {
    const provider = MERGE_RUN.provider();
    const reply = await textOf(scriptedSession(provider).submit('merge two videos'));
    expect(reply.types[0]).toBe('RUN_STARTED');
    const spec = await validated(reply.text);
    expect(spec).toEqual(MERGE_SPEC);

    const host = await mountHeadless({
      spec,
      catalog: videoMergeCatalog,
      binding: createInkBinding(videoMergeCatalog),
      permission: createMockPermissionEngine({ merge: 'ask' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_OK }),
    });
    try {
      const focusedLine = (): number =>
        host
          .frame()
          .split('\n')
          .findIndex((line) => line.includes('> '));
      const onMerge = (): boolean =>
        host.frame().split('\n')[focusedLine()]?.includes('Merge') === true;
      await host.waitFor(() => focusedLine() >= 0, 'a focused widget');
      for (let i = 0; i < 6 && !onMerge(); i++) {
        const before = focusedLine();
        await host.press('tab');
        await host.waitFor(() => focusedLine() !== before, 'the focus to move');
      }
      await host.waitFor(onMerge, 'focus on the Merge button');
      await host.press('enter');
      await host.waitFor(
        () => host.frame().includes('Allow? [a]lways / [y]es / [n]o'),
        'the consent box',
      );
      await host.press('y');
      await host.settle();
      await host.waitFor(() => host.frame().includes('█'), 'the filled bar');
      await host.waitFor(() => host.outcomes().length === 1, 'the merge outcome');
      expect(host.outcomes()).toMatchObject([{ status: 'settled' }]);
      expect(matchGolden('merge-spine-done', host.frame(), { dir: GOLDEN_DIR }).pass).toBe(true);
    } finally {
      host.unmount();
    }
  });

  it('a failed merge goes back to the same session as a repair turn that carries the fault', async () => {
    const provider = MERGE_RUN.provider();
    const session = scriptedSession(provider);
    const spec = await validated((await textOf(session.submit('merge two videos'))).text);
    const host = await mountHeadless({
      spec,
      catalog: videoMergeCatalog,
      binding: createInkBinding(videoMergeCatalog),
      permission: createMockPermissionEngine({ merge: 'allow' }),
      tools: createMockToolRegistry({ merge: MERGE_TOOL_FAIL }),
    });
    let fault: RuntimeFault | undefined;
    try {
      const outcome = await host.dispatch('merge');
      if (outcome.status !== 'failed') throw new Error(`the merge did not fail: ${outcome.status}`);
      fault = outcome.fault;
    } finally {
      host.unmount();
    }
    const before = provider.receivedRequests().length;
    const repair = await textOf(
      routeRuntimeFault(fault, session, (f) => toRuntimeRepair(f, CATALOG_REPAIR_WORDING).reprompt),
    );
    expect(repair.types[0]).toBe('RUN_STARTED');
    expect(provider.receivedRequests()).toHaveLength(before + 1);
    expect(JSON.stringify(provider.receivedRequests().at(-1))).toContain('Unknown encoder h265');
    expect(await validated(repair.text)).toEqual(MERGE_SPEC);
  });
});

// The exit keys reach the host through the real Ink renderer: q ends the app as completed, Esc as
// cancelled, and nothing reaches exec.
const noExec: ActionDispatcher = {
  dispatch: (name) => Promise.reject(new Error(`a key press reached exec: ${name}`)),
};

describe('the exit keys through the host and the real renderer', () => {
  it('q settles the session as completed with exit 0', async () => {
    const app = await inkUnderHost({ spec: MERGE_SPEC, dispatcher: noExec });
    await app.press('q');
    expect(await app.session.done).toEqual({ status: 'completed', exitCode: 0 });
    app.session.dispose();
  });

  it('Esc settles the session as cancelled with exit 130', async () => {
    const app = await inkUnderHost({ spec: MERGE_SPEC, dispatcher: noExec });
    await app.press('escape');
    expect(await app.session.done).toEqual({ status: 'cancelled', exitCode: 130 });
    app.session.dispose();
  });
});
