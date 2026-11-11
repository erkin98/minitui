import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChecksum } from '../grammar-checksum.mjs';

const at = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const manifest: Record<string, string> = JSON.parse(
  readFileSync(at('../grammar-checksums.json'), 'utf8'),
);
const installed: Record<string, string> = {
  'tree-sitter-bash.wasm': at(
    '../../packages/exec/node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
  ),
  'tree-sitter.wasm': at('../../packages/exec/node_modules/web-tree-sitter/tree-sitter.wasm'),
};

describe('the parser wasm checksums', () => {
  it('the manifest pins exactly the grammar and the parser runtime', () => {
    expect(Object.keys(manifest).sort()).toEqual(['tree-sitter-bash.wasm', 'tree-sitter.wasm']);
  });
  it.each(Object.entries(installed))('the installed %s matches its pinned hash', (name, file) => {
    expect(verifyChecksum(file, manifest[name] ?? '')).toBe(true);
  });
  it('a changed byte fails the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wasm-'));
    try {
      const bytes = readFileSync(installed['tree-sitter.wasm'] ?? '');
      const last = bytes.length - 1;
      bytes[last] = (bytes[last] ?? 0) ^ 0xff;
      const copy = join(dir, 'tree-sitter.wasm');
      writeFileSync(copy, bytes);
      expect(verifyChecksum(copy, manifest['tree-sitter.wasm'] ?? '')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
