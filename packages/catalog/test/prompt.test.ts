import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { compileSpecStream } from '@json-render/core';
import { AppSpecSchema, JsonValueSchema } from '@minitui/types';
import { defineMinituiCatalog, type MinituiCatalog } from '../src/define-catalog.js';
import { buildCatalogPrompt } from '../src/prompt.js';
import { videoMergeCatalog } from '../src/catalogs/video-merge.js';
import { standardComponentDefinitions } from '../src/schema-bridge.js';
import { runFullValidation } from '../src/validate/index.js';

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

// The shipped catalog's prompt is what the model reads, so the rows below read it whole.
const shipped = buildCatalogPrompt(videoMergeCatalog);
const shippedLines = shipped.split('\n');

const wordsOf = (text: string): Set<string> => new Set(text.match(/[A-Za-z0-9_]+/g) ?? []);

// An example block is an "Example" line plus the line right after it when that one is not blank.
function exampleBlocks(lines: readonly string[]): string[] {
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('Example')) return;
    const next = lines[i + 1];
    blocks.push(next === undefined || next === '' ? line : `${line}\n${next}`);
  });
  return blocks;
}

const MERGE_PARAMS_LINE =
  '  params: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"inputs":{"minItems":2,"type":"array","items":{"type":"string"}},"codec":{"type":"string"},"output":{"type":"string"}},"required":["inputs","codec","output"],"additionalProperties":false}';

// A hand-built catalog whose adopted prompt text lacks one marker line: a real object
// implementing the one method the package reads from the adopted catalog.
function catalogMissing(marker: string): MinituiCatalog {
  const text = videoMergeCatalog.base
    .prompt({ mode: 'standalone' })
    .split('\n')
    .filter((line) => line !== marker)
    .join('\n');
  return { ...videoMergeCatalog, base: { prompt: () => text } };
}

describe('the shipped prompt', () => {
  it('asks for JSONL patches only, with no fence and no prose', () => {
    expect(shipped).toContain('Output ONLY JSONL patches');
    expect(shipped).not.toContain('```spec');
    expect(shipped).not.toContain('brief explanation');
  });

  it('has no state-watcher section but keeps the rules', () => {
    expect(shippedLines).not.toContain('STATE WATCHERS:');
    expect(shipped).not.toContain('loadCities');
    expect(shippedLines).toContain('RULES:');
  });

  it('carries exactly one rule about watch and it says watch is not supported', () => {
    const rules = shippedLines.filter((line) => /^\d+\. /.test(line) && /\bwatch\b/.test(line));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('not supported');
    expect(rules[0]).toContain('`on`');
  });

  it('names no standard component the catalog does not register', () => {
    const registered = new Set(videoMergeCatalog.componentNames);
    const unregistered = Object.keys(standardComponentDefinitions).filter(
      (n) => !registered.has(n),
    );
    expect(unregistered).toContain('Heading');
    const words = wordsOf(shipped);
    expect(unregistered.filter((name) => words.has(name))).toEqual([]);
  });

  it('keeps the adopted rules that name only registered components', () => {
    expect(shipped).toContain('This UI renders in a terminal using Ink. Use Box for layout');
  });

  it('shows no example that uses an action outside the catalog', () => {
    const names = exampleBlocks(shippedLines).flatMap((block) =>
      [...block.matchAll(/"action"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(
      names.filter((n) => n !== undefined && !videoMergeCatalog.actionNames.includes(n)),
    ).toEqual([]);
  });

  it('prints no built-in action line', () => {
    expect(shippedLines.filter((line) => line.includes('[built-in]'))).toEqual([]);
  });

  it('prints the params of every action as a JSON Schema line under the action', () => {
    for (const [name, def] of videoMergeCatalog.actionDefs) {
      const at = shippedLines.findIndex(
        (l) => l.startsWith(`- ${name} (`) || l.startsWith(`- ${name}: render-local`),
      );
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(shippedLines[at + 1], name).toBe(
        `  params: ${JSON.stringify(z.toJSONSchema(def.params))}`,
      );
    }
  });

  it('prints the merge params line in a fixed form', () => {
    expect(shippedLines).toContain(MERGE_PARAMS_LINE);
  });

  it('declares the events of the three custom components', () => {
    const line = (name: string) => shippedLines.find((l) => l.startsWith(`- ${name}:`)) ?? '';
    expect(line('Button')).toContain('[events: press]');
    expect(line('FilePicker')).toContain('[events: change]');
    expect(line('OrderList')).toContain('[events: reorder]');
  });

  it('names the state pointers the merge resource template needs', () => {
    const at = shippedLines.indexOf(MERGE_PARAMS_LINE);
    const line = shippedLines[at + 1] ?? '';
    for (const pointer of ['/inputs/0', '/inputs/1', '/codec', '/output']) {
      expect(line, pointer).toContain(pointer);
    }
  });

  it('labels merge as a dangerous exec-local action', () => {
    expect(shipped).toContain('- merge (exec-local, DANGEROUS)');
  });

  it('throws at build time when the generator no longer prints the watcher marker', () => {
    expect(() => buildCatalogPrompt(catalogMissing('STATE WATCHERS:'))).toThrow(/STATE WATCHERS:/);
  });

  it('throws at build time when the generator no longer prints the rules marker', () => {
    expect(() => buildCatalogPrompt(catalogMissing('RULES:'))).toThrow(/RULES:/);
  });

  it('teaches an example output the full validation accepts', () => {
    const start = shippedLines.findIndex((l) => l.startsWith('Example output'));
    const jsonl: string[] = [];
    for (const l of shippedLines.slice(start + 1)) {
      if (l.startsWith('Note:')) break;
      if (l !== '') jsonl.push(l);
    }
    const compiled = compileSpecStream(jsonl.join('\n'));
    const spec = AppSpecSchema.parse({ root: compiled.root, elements: compiled.elements });
    const state = JsonValueSchema.parse(compiled.state ?? {});
    expect(runFullValidation(spec, videoMergeCatalog, state)).toEqual({ ok: true });
  });
});
