import { createSpecStreamCompiler } from '@json-render/core';
import type { Spec } from './spec-types.js';

// Re-export the adopted compiler verbatim (the decided wire model is JSONL
// RFC-6902 patch lines — the compiler itself buffers incomplete lines).
export { createSpecStreamCompiler };

/** RFC-6901 reference tokens that reach a prototype when used as an object key. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Decode one RFC-6901 reference token (`~1`→`/`, `~0`→`~`). */
function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Reject a model-authored patch whose RFC-6901 `path`/`from` walks a reserved
 * prototype segment BEFORE it reaches the sink. The adopted compiler routes
 * add/replace/move/copy through json-render's `addByPath`/`setByPath`
 * (repos/json-render/packages/core/src/types.ts:346,396) — an `in`-guarded write
 * that follows the prototype chain, so a line `{"op":"add","path":"/__proto__/x"}`
 * would mutate `Object.prototype` process-wide, UPSTREAM of the catalog gate (this
 * drains the model stream FIRST in composeValidation). This is the SPEC twin of
 * the STATE-delta guard (`banPrototypeModifications`); json-render
 * ships no such flag, so the reject is explicit and fail-closed. The throw is
 * caught one level up (composeValidation) and burns a repair attempt — the sink
 * never runs. (Moat: the no-code catalog seam.)
 */
function assertSafePatchPath(line: string): void {
  const patch = JSON.parse(line) as { path?: unknown; from?: unknown };
  for (const ref of [patch.path, patch.from]) {
    if (typeof ref !== 'string') continue;
    for (const token of ref.split('/')) {
      if (RESERVED_SEGMENTS.has(decodeToken(token))) {
        throw new Error(`spec-stream patch rejected: reserved prototype segment in path "${ref}"`);
      }
    }
  }
}

/**
 * Drain a JSONL patch-line stream into a final Spec. Chunks are line-buffered
 * HERE (not delegated to the compiler's own buffering) so every COMPLETE patch
 * line is screened by assertSafePatchPath — the reserved-key reject —
 * before it reaches `compiler.push` and the pollutable sink. The double JSON
 * parse (screen here, apply in the compiler) is the deliberate price of screening
 * upstream of the sink; the compiler's string-only `push` offers no pre-apply hook.
 * No partial-json dep, no growing whole-object parse.
 */
export async function compileSpecStream(stream: AsyncIterable<string>): Promise<Spec> {
  const compiler = createSpecStreamCompiler<Spec>({});
  let buffer = '';
  const pushLine = (line: string): void => {
    if (line.trim() === '') return;
    assertSafePatchPath(line); // screen the path BEFORE the pollutable sink
    compiler.push(line + '\n');
  };
  for await (const chunk of stream) {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      pushLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  pushLine(buffer); // flush a final unterminated line
  return compiler.getResult();
}
