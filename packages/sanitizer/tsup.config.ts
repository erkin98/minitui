import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // composite:false — under the composite base, dts:true reds TS6307 and silently
  // emits no .d.ts (§Z97). The banner closes the published declaration graph
  // (§Z80 addendum): sanitizeStream's public return type names the ambient
  // TransformStream, and a strict consumer (types:[] lib:[ES2023]
  // skipLibCheck:false) has no automatic @types inclusion — the reference
  // resolves @types/node from THIS package's own dependencies (why @types/node
  // is a published dep). @types/node ships type declarations only — zero
  // runtime code, nothing enters the tsup bundle — so the zero-dependency
  // chokepoint invariant (no runtime code but ours) is intact.
  dts: {
    compilerOptions: { composite: false },
    banner: '/// <reference types="node" />',
  },
  clean: true,
  target: 'node22',
});
