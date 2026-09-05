// Pure grammar-checksum predicate. Hash `file`'s bytes and constant-time-compare against expectedHex
// (lowercase hex sha256). Synchronous (the consumer asserts on the return value directly, no await);
// never throws on a mismatch (returns false) — only a missing/unreadable file throws, which the
// copy-loop check in bundle-grammars.mjs treats as fatal (fail loud, never silently skip). Lives in
// its own module so the grammar-swap security gate can assert the fail-closed property against
// synthetic bytes without pulling in the copy loop. Buffer is imported (the **/*.mjs lint block
// declares no Node globals, so an un-imported Buffer would fail no-undef).
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function verifyChecksum(file, expectedHex) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
