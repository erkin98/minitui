import { describe, it, expect } from 'vitest';
import { buildCatalogPrompt, videoMergeCatalog } from '@minitui/catalog';
import { compileSpecStream } from '../src/stream-compile.js';
import { caps, drive, lastEnvelope, once } from './support/driver.js';

// The patch lines of the example that the prompt teaches, as the model would copy them.
const example =
  buildCatalogPrompt(videoMergeCatalog)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"op"'))
    .join('\n') + '\n';

describe('the example in the catalog prompt', () => {
  it('guard: it has at least three patch lines and compiles to a root and elements', async () => {
    expect(example.split('\n').filter((l) => l !== '').length).toBeGreaterThanOrEqual(3);
    const spec = await compileSpecStream(once(example));
    expect(typeof spec.root).toBe('string');
    expect(Object.keys(spec.elements).length).toBeGreaterThan(0);
  });

  it('is accepted by the loop with no regeneration', async () => {
    const run = await drive({ replies: [example], capabilities: caps });
    if (run.result !== undefined && !run.result.ok) {
      throw new Error(JSON.stringify(run.result.lastEnvelope));
    }
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(0);
  });
});

describe('a reply that is not patch lines', () => {
  const prose = 'PRIVATE-PROSE here is the app you asked for';
  const fenced = '```spec\n' + example + '```\n';

  it('prose followed by a fenced block is one regeneration; the reprompt says JSONL and not the prose', async () => {
    const run = await drive({ replies: [prose + '\n' + fenced, example] });
    expect(run.result?.ok).toBe(true);
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('JSONL');
    expect(run.reprompts[0]).not.toContain('PRIVATE-PROSE');
  });

  it('the same fenced reply on every pass gives up after five regenerations without throwing', async () => {
    const run = await drive({ replies: [prose + '\n' + fenced] });
    expect(run.thrown).toBeUndefined();
    expect(run.regenerations).toBe(5);
    expect(lastEnvelope(run).attempt).toBe(6);
  });

  it('a non-JSON line is told to send JSONL only', async () => {
    const run = await drive({ replies: ['this is not json\n', example] });
    expect(run.regenerations).toBe(1);
    expect(run.reprompts[0]).toContain('JSONL');
  });
});
