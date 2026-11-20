import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiagnosticsPort } from '@minitui/types';
import { createModelRoute } from '../../src/model-route.js';
import type { EvalRow } from '../../eval/harness/row.js';
import { fixedCapabilities } from '../../eval/harness/scripted.js';
import type { EvalDeps } from '../../eval/main.js';
import { anthropicEntry } from '../../eval/providers/anthropic.js';
import type { ProviderEntry } from '../../eval/providers/index.js';

// What the eval entry's tests share: case sets built from the committed ones, the entry's seams with
// fixed values, and provider entries that are real implementations of the port over a fetch with no network.

const CASES_DIR = fileURLToPath(new URL('../../eval/cases/', import.meta.url));

/** Every codec a reference names, so a merge reference validates against the fixed capabilities. */
export const CODECS = ['h264', 'libx264', 'hevc', 'libx265', 'mpeg4', 'vp9', 'libvpx-vp9', 'copy'];

export const RUN_ID = '20261120T100000Z-0a1b2c3d';
export const MODEL = 'test-model';
export const START = new Date('2026-11-20T10:00:00Z');

/** A price file the tests own, dated the run's day: prices.json's rates under a test model id. */
export const priceTextFor = (provider: string, date = '2026-11-20'): string =>
  JSON.stringify({
    date,
    source: 'test',
    models: { [`${provider}:${MODEL}`]: { input: 2, cacheWrite: 4, cacheRead: 0.1, output: 10 } },
  });

type Json = Record<string, unknown>;

const committedCases = (): Json[] =>
  readFileSync(join(CASES_DIR, 'generation.v1.jsonl'), 'utf8')
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line): Json => JSON.parse(line));

/** The committed case with this id, as a JSON object. */
export function committedCase(id: string): Json {
  const found = committedCases().find((c) => c.id === id);
  if (found === undefined) throw new Error(`no committed case ${id}`);
  return found;
}

export const committedReference = (file: string): string =>
  readFileSync(join(CASES_DIR, 'references', file), 'utf8');

const filesOf = (c: Json): string[] => {
  const dry = c.dryRun;
  const reply =
    typeof dry === 'object' && dry !== null && 'reply' in dry && typeof dry.reply === 'string'
      ? dry.reply
      : null;
  return [c.reference, reply].filter((f): f is string => typeof f === 'string');
};

/**
 * A case file in `dir`, with its references beside it: the cases in the order given, each reference the
 * committed one unless `references` gives its text.
 */
export function writeCaseSet(
  dir: string,
  cases: readonly Json[],
  references: Readonly<Record<string, string>> = {},
): string {
  mkdirSync(join(dir, 'references'), { recursive: true });
  for (const file of cases.flatMap(filesOf)) {
    writeFileSync(join(dir, 'references', file), references[file] ?? committedReference(file));
  }
  const lines = [{ status: 'draft', caseSetVersion: 1 }, ...cases].map((c) => JSON.stringify(c));
  const path = join(dir, 'cases.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** A temporary directory per test file; `cleanup` removes them all. */
export function tempDirs(): { readonly make: () => string; readonly cleanup: () => void } {
  const made: string[] = [];
  return {
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), 'minitui-eval-main-test-'));
      made.push(dir);
      return dir;
    },
    cleanup: () => {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The entry's seams with fixed values, the printed lines captured. */
export function testDeps(over: EvalDeps = {}): {
  readonly deps: EvalDeps;
  readonly out: string[];
  readonly err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      env: {},
      now: () => START,
      randomHex: () => '0a1b2c3d',
      capabilities: fixedCapabilities(CODECS),
      priceText: () => priceTextFor('anthropic'),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      ...over,
    },
  };
}

/** The rows of the run directory, parsed back. */
export const rowsIn = (runDir: string): EvalRow[] =>
  readFileSync(join(runDir, 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): EvalRow => JSON.parse(line));

export const filesIn = (dir: string): string[] => readdirSync(dir).sort();

/** The replay entry, its routes noting every request they are sent. */
export function recordingReplay(): {
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  readonly requests: () => number;
} {
  let requests = 0;
  const entry: ProviderEntry = {
    ...anthropicEntry,
    replay: (key) => {
      const access = anthropicEntry.replay(key);
      return {
        ...access,
        route: (args) =>
          access.route({
            ...args,
            onRequest: () => {
              requests += 1;
            },
          }),
      };
    },
  };
  return { providers: { anthropic: entry }, requests: () => requests };
}

/** The replay entry, every route answering with `text` in place of the case's reply. */
export function answeringReplay(text: string): Readonly<Record<string, ProviderEntry>> {
  const entry: ProviderEntry = {
    ...anthropicEntry,
    replay: (key) => {
      const access = anthropicEntry.replay(key);
      return {
        ...access,
        route: (args) =>
          access.route({ ...args, replies: args.replies.map((reply) => ({ ...reply, text })) }),
      };
    },
  };
  return { anthropic: entry };
}

/** The replay entry over a fetch that rejects every request with `message`, noting each one it threw. */
export function failingReplay(message: string): {
  readonly providers: Readonly<Record<string, ProviderEntry>>;
  readonly thrown: string[];
} {
  const thrown: string[] = [];
  const entry: ProviderEntry = {
    ...anthropicEntry,
    replay: (key) => {
      const access = anthropicEntry.replay(key);
      return {
        ...access,
        route: (args) =>
          createModelRoute({
            apiKey: key,
            modelId: args.model,
            diagnostics: args.diagnostics,
            redactionPolicy: access.redactionPolicy,
            fetch: args.meter(() => {
              thrown.push(message);
              return Promise.reject(new Error(message));
            }),
          }),
      };
    },
  };
  return { providers: { anthropic: entry }, thrown };
}

/** Forwards every record but the model step one. */
export function droppingStepRecord(next: DiagnosticsPort): DiagnosticsPort {
  return {
    warn: (msg, meta) => next.warn(msg, meta),
    debug: (msg, meta) => {
      if (msg !== 'model step') next.debug(msg, meta);
    },
  };
}
