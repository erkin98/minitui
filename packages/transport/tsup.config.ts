import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // composite:false — under the composite base, dts:true reds TS6307 and SILENTLY
  // emits no .d.ts while the ESM bundle still succeeds (§Z97). The banner makes the
  // published declaration graph dependency-CLOSED (§Z80/§Z102): the agent seam names
  // the ambient AbortSignal (RunHandle.signal, createAbort), and a strict consumer
  // (types:[] lib:[ES2023] skipLibCheck:false) has no automatic @types inclusion —
  // the reference resolves @types/node from THIS package's own dependencies (why
  // @types/node is a published dep, not a devDep). The rollup drops a source-level
  // triple-slash ref, so it must be injected at emit.
  dts: {
    compilerOptions: { composite: false },
    banner: '/// <reference types="node" />',
  },
  sourcemap: true,
  clean: true,
  target: 'node22',
});
