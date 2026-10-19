import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // The published declarations name the ambient AbortSignal, and a strict consumer has no automatic @types
  // inclusion: the banner makes the declaration graph dependency-closed (the reference resolves
  // @types/node from THIS package's own dependencies). The declaration rollup drops a source-level
  // triple-slash reference, so it is injected at emit.
  dts: {
    compilerOptions: { composite: false },
    banner: '/// <reference types="node" />',
  },
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: ['ai', '@ai-sdk/anthropic', 'zod', '@minitui/types'],
});
