import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsiNondeterminism } from './determinism.js';

/** The outcome of one comparison. The caller asserts on `pass`; a call nobody asserts on checks nothing. */
export interface GoldenResult {
  readonly pass: boolean;
  readonly diff?: string;
  readonly created?: boolean;
}

function lineDiff(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] === a[i]) continue;
    if (e[i] !== undefined) lines.push(`-${e[i]}`);
    if (a[i] !== undefined) lines.push(`+${a[i]}`);
  }
  return lines.join('\n');
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Compare a frame with the committed golden `<name>.ansi` in `dir`, which the caller gives as a URL
 * (`new URL('./__golden__/', import.meta.url)`), so the working directory never matters. A missing golden
 * fails in every lane: a deleted or renamed file can never pass by being written again. Only an explicit
 * `UPDATE_GOLDEN=1` writes (or overwrites) the golden, and then the comparison passes.
 */
export function matchGolden(
  name: string,
  actual: string,
  opts: { readonly dir: URL; readonly raw?: boolean | undefined },
): GoldenResult {
  const dir = fileURLToPath(opts.dir);
  const file = join(dir, `${name}.ansi`);
  const normalized = opts.raw === true ? actual : stripAnsiNondeterminism(actual);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dir, { recursive: true });
    writeAtomic(file, normalized);
    return { pass: true, created: true };
  }
  if (!existsSync(file)) {
    return {
      pass: false,
      diff: `missing golden: ${file} (write it with UPDATE_GOLDEN=1 and commit the .ansi file)`,
    };
  }
  const stored = readFileSync(file, 'utf8');
  return stored === normalized
    ? { pass: true }
    : { pass: false, diff: lineDiff(stored, normalized) };
}
