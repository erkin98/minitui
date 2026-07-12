// vitest.shared.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export const sharedVitestConfig = defineConfig({
  resolve: {
    // Dedup React/Ink under Vitest's transform (json-render's vitest pattern):
    // pnpm strict resolution can hand two packages two copies; the alias forces the
    // hoisted root copy so the Ink reconciler never sees a second React.
    alias: {
      react: fromRoot('./node_modules/react'),
      'react-dom': fromRoot('./node_modules/react-dom'),
      ink: fromRoot('./node_modules/ink'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: [fromRoot('./vitest.determinism.setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});

export default sharedVitestConfig;
