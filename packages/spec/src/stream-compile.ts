import {
  addByPath,
  applySpecStreamPatch,
  createSpecStreamCompiler,
  getByPath,
  parseSpecStreamLine,
} from '@json-render/core';
import { decodePointerToken, JSON_RESOURCE_LIMITS, RESERVED_JSON_KEYS } from '@minitui/types';
import type { Spec } from './spec-types.js';

// Re-export the adopted compiler verbatim (the decided wire model is JSONL RFC-6902 patch lines). This
// module does not apply lines through it: the adopted compiler skips a line whose text it has already
// seen, which drops a legitimately repeated patch.
export { createSpecStreamCompiler };

/**
 * A problem in the model's patch lines. The loop turns exactly this class into a repair attempt; every
 * other error of the compile step is an error of the source stream and passes through unchanged. The
 * message is one of three fixed sentences and holds nothing the model wrote or a parser said.
 */
export class SpecStreamContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecStreamContentError';
  }
}

const NOT_JSONL =
  'reply with JSONL only: one JSON patch object per line, no prose and no code fence';
const RESERVED_PATH = 'a patch path walks a reserved prototype segment';
const NOT_APPLIED = 'a patch line could not be applied to the spec';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reject a model-authored patch whose RFC-6901 `path`/`from` walks a reserved
 * prototype segment BEFORE it reaches the sink. The adopted compiler routes
 * add/replace/move/copy through json-render's `addByPath`/`setByPath`
 * (the adopted core package's `types.ts`) — an `in`-guarded write
 * that follows the prototype chain, so a line `{"op":"add","path":"/__proto__/x"}`
 * would mutate `Object.prototype` process-wide, UPSTREAM of the catalog gate (this
 * drains the model stream FIRST in composeValidation). This is the SPEC twin of
 * the STATE-delta guard (`banPrototypeModifications`); json-render
 * ships no such flag, so the reject is explicit and fail-closed. The throw is a content
 * error: composeValidation turns it into a repair attempt and the sink never runs. The
 * message does not repeat the path. (Moat: the no-code catalog seam.)
 */
function assertSafePatchPath(patch: Record<string, unknown>): void {
  for (const ref of [patch.path, patch.from]) {
    if (typeof ref !== 'string') continue;
    for (const token of ref.split('/')) {
      if (RESERVED_JSON_KEYS.includes(decodePointerToken(token)))
        throw new SpecStreamContentError(RESERVED_PATH);
    }
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new SpecStreamContentError(NOT_JSONL);
  }
}

// One budget of nodes for every clone made while draining one stream.
interface CloneBudget {
  left: number;
}

const copyShell = (value: unknown): unknown =>
  Array.isArray(value) ? [] : isRecord(value) ? {} : value;

/**
 * A structured clone of a JSON array or object, charged against `budget` one node per value. Own keys are
 * defined as data properties, never assigned, so an own `__proto__` key stays data. Iterative, so depth
 * cannot overflow the stack; past the budget it throws the content error.
 */
function cloneCounted(source: unknown, budget: CloneBudget): unknown {
  const take = (): void => {
    budget.left -= 1;
    if (budget.left < 0) throw new SpecStreamContentError(NOT_APPLIED);
  };
  take();
  const top = copyShell(source);
  const pending: Array<readonly [unknown, unknown]> = [[source, top]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [from, to] = pair;
    if (Array.isArray(from) && Array.isArray(to)) {
      for (const item of from) {
        take();
        const made = copyShell(item);
        to.push(made);
        if (made !== item) pending.push([item, made]);
      }
    } else if (isRecord(from) && isRecord(to)) {
      for (const [key, item] of Object.entries(from)) {
        take();
        const made = copyShell(item);
        Object.defineProperty(to, key, {
          value: made,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (made !== item) pending.push([item, made]);
      }
    }
  }
  return top;
}

/**
 * Drain a JSONL patch-line stream into a final Spec. Chunks are line-buffered HERE so every COMPLETE
 * patch line is screened by assertSafePatchPath — the reserved-key reject — before it is applied to the
 * pollutable sink, and each line is applied with the adopted `applySpecStreamPatch` onto one accumulating
 * object. A `copy` whose source is an object or an array is applied as an add of a structured clone, so
 * no value ever sits at two places; the clones of one stream share one budget of
 * `JSON_RESOURCE_LIMITS.maxNodes` nodes. No partial-json dep, no growing whole-object parse.
 *
 * A problem in a line throws a SpecStreamContentError. The iteration of the source stream sits
 * outside every try, so an error of the source passes as the same object.
 */
export async function compileSpecStream(stream: AsyncIterable<string>): Promise<Spec> {
  // the object every line is applied to; the adopted patch functions take a plain record
  const result: Record<string, unknown> = {};
  const budget: CloneBudget = { left: JSON_RESOURCE_LIMITS.maxNodes };
  // The pieces of the line not yet ended. Each chunk is scanned once for a newline, so a long line costs
  // time in proportion to its length; appending to one string and scanning it again per chunk would
  // cost its length squared.
  let pending: string[] = [];
  const pushLine = (line: string): void => {
    if (line.trim() === '') return;
    const parsed = parseLine(line);
    if (!isRecord(parsed)) return; // not a patch object: skipped, as the adopted line parser skips it
    assertSafePatchPath(parsed); // screen the path BEFORE the pollutable sink
    const patch = parseSpecStreamLine(line);
    if (patch === null) return; // no op or no path: skipped, as the adopted compiler skips it
    try {
      if (patch.op === 'copy' && patch.from) {
        const source: unknown = getByPath(result, patch.from);
        if (Array.isArray(source) || isRecord(source)) {
          addByPath(result, patch.path, cloneCounted(source, budget));
          return;
        }
      }
      applySpecStreamPatch(result, patch);
    } catch (error) {
      if (error instanceof SpecStreamContentError) throw error;
      throw new SpecStreamContentError(NOT_APPLIED);
    }
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', start)) {
      pending.push(chunk.slice(start, nl));
      const line = pending.join('');
      pending = [];
      pushLine(line);
      start = nl + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  pushLine(pending.join('')); // flush a final unterminated line
  // Typed as a Spec like the adopted compiler's own result, and not yet trusted: the screen and the wire
  // parse that follow check the shape.
  return result as unknown as Spec;
}
