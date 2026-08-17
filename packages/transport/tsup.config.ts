import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // composite:false avoids TS6307 and guarantees declaration emission under the
  // composite source project. The banner makes the published declaration graph
  // dependency-closed because the agent seam names
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
