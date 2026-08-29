import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineMinituiCatalog } from '@minitui/catalog';
import { composeValidation, toWireSpec } from '../src/loop.js';
import type { CapabilityProvider } from '../src/capability-port.js';
import type { MiniAppSpec } from '../src/spec-types.js';

async function* once(s: string): AsyncIterable<string> {
  yield s;
}

const caps: CapabilityProvider = {
  listEncoders: async () => ['libx264'],
  listCodecs: async () => ['h264'],
  listFilters: async () => ['scale'],
  statFile: async () => ({ exists: true, readable: true, isFile: true }),
};

// A REAL catalog handle with Box registered (typed MinituiCatalog,
// no `as never`/hand-rolled shell). composeValidation CALLS runFullValidation
// against it, so the handle must be a working catalog — the factory is the same
// one every catalog is built with.
const catalog = defineMinituiCatalog({
  id: 'test',
  components: {
    Box: { props: z.object({}).strict(), slots: [], description: 'box', trustTier: 'display' },
  },
  actions: {},
});

const validSpecJsonl =
  '{"op":"add","path":"/root","value":"f"}\n' +
  '{"op":"add","path":"/elements","value":{"f":{"type":"Box","props":{}}}}\n' +
  '{"op":"add","path":"/state","value":{}}\n';

describe('composeValidation', () => {
  it('returns ok with a MiniAppSpec when the first stream is valid', async () => {
    const r = await composeValidation({
      stream: once(validSpecJsonl),
      catalog,
      capabilities: caps,
      regenerate: () => once(validSpecJsonl),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.root).toBe('f');
  });

  it('reprompts with the envelope text, then succeeds on the regenerated stream', async () => {
    const badJsonl = '{"op":"add","path":"/elements","value":{}}\n'; // no root
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(badJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('root');
    expect(r.ok).toBe(true);
  });

  it('rejects an off-catalog component through the catalog gate and reprompts', async () => {
    // Structurally valid, but "Iframe" is not registered in the catalog — only
    // runFullValidation can catch it. This is the wiring proof for the dead-catalog
    // case: if the loop never called the gate, this spec would pass.
    const offCatalogJsonl =
      '{"op":"add","path":"/root","value":"f"}\n' +
      '{"op":"add","path":"/elements","value":{"f":{"type":"Iframe","props":{}}}}\n' +
      '{"op":"add","path":"/state","value":{}}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(offCatalogJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('Iframe'); // runFullValidation's unknown-component message
    expect(r.ok).toBe(true);
  });

  it('rejects an agent-widened visibility through the visibility gate and reprompts', async () => {
    // Box is catalog-declared with the default clientOnly class; the agent smuggles
    // a wider `visibility: 'remoteOnly'` onto the element — an excess field the wire
    // type does not model and strict-props never sees. Only checkVisibility catches it
    // (it runs after the catalog gate, before the port-semantic probes).
    const widenedJsonl =
      '{"op":"add","path":"/root","value":"f"}\n' +
      '{"op":"add","path":"/elements","value":{"f":{"type":"Box","props":{},"visibility":"remoteOnly"}}}\n' +
      '{"op":"add","path":"/state","value":{}}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(widenedJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('visibility'); // checkVisibility's widen message
    expect(r.ok).toBe(true);
  });

  it('gives up after MAX_RETRIES with the last envelope', async () => {
    const badJsonl = '{"op":"add","path":"/elements","value":{}}\n';
    const r = await composeValidation({
      stream: once(badJsonl),
      catalog,
      capabilities: caps,
      regenerate: () => once(badJsonl),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastEnvelope.code).toBe('VALIDATION_FAILED');
      expect(r.lastEnvelope.attempt).toBe(6); // total passes = MAX_RETRIES+1 (1 initial + 5 regenerations)
    }
  });

  it('turns a model-stream compile throw into a reprompt, never escaping', async () => {
    // A failing RFC-6902 `test` op throws inside json-render's applySpecStreamPatch;
    // the untrusted-boundary catch converts it to a repair attempt, not a crash.
    const throwingJsonl = '{"op":"test","path":"/root","value":"nope"}\n';
    let seenReprompt = '';
    const r = await composeValidation({
      stream: once(throwingJsonl),
      catalog,
      capabilities: caps,
      regenerate: (reprompt) => {
        seenReprompt = reprompt;
        return once(validSpecJsonl);
      },
    });
    expect(seenReprompt).toContain('did not compile');
    expect(r.ok).toBe(true);
  });

  it('survives an empty stream by reprompting rather than throwing', async () => {
    const r = await composeValidation({
      stream: once(''),
      catalog,
      capabilities: caps,
      regenerate: () => once(''),
    });
    expect(r.ok).toBe(false); // never resolves to a spec, but never throws
  });
});

describe('toWireSpec', () => {
  it('toWireSpec is state-free at runtime — drops state and meta', () => {
    const mini: MiniAppSpec = {
      root: 'r',
      elements: {},
      state: { secret: 'x' },
      meta: { catalogId: 'c', schemaVersion: 1, sourcePrompt: 'user prompt' },
    };
    const wire = toWireSpec(mini);
    expect(Object.keys(wire).sort()).toEqual(['elements', 'root']);
    expect('state' in wire).toBe(false);
    expect('meta' in wire).toBe(false);
  });
});
