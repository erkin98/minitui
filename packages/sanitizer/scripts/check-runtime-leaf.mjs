import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { externalBundledInputs } from './runtime-leaf.mjs';

const metafile = fileURLToPath(new URL('../dist/metafile-esm.json', import.meta.url));

try {
  if (!existsSync(metafile)) throw new Error('tsup did not emit the sanitizer metafile');
  const external = externalBundledInputs(JSON.parse(readFileSync(metafile, 'utf8')));
  if (external.length > 0) {
    throw new Error(`sanitizer runtime bundle contains external inputs: ${external.join(', ')}`);
  }
} finally {
  if (existsSync(metafile)) unlinkSync(metafile);
}
