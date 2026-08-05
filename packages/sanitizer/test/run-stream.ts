import { sanitizeStream } from '../src/index.js';
import type { SanitizeOptions } from '../src/index.js';

/**
 * Drive `sanitizeStream` over a chunk list through its real TransformStream and
 * return the concatenated output. Not a double of anything — it is the
 * production seam, written once instead of once per test file.
 */
export async function runStream(chunks: string[], opts?: SanitizeOptions): Promise<string> {
  const t = sanitizeStream(opts);
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const out: string[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const c of chunks) await writer.write(c);
  await writer.close();
  await pump;
  return out.join('');
}
