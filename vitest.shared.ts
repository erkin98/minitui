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
    // surface.test.ts builds a real TypeScript program per test, ~1.5s uninstrumented
    // but 4-6.4s once V8 coverage instrumentation is attached. The 5000ms vitest
    // default straddles that range, so coverage runs fail intermittently on slower
    // machines/CI. 20s gives ~3x headroom over the slowest observed coverage run.
    testTimeout: 20_000,
    setupFiles: [fromRoot('./vitest.determinism.setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [fromRoot('./packages/*/src/**/*.ts')],
      exclude: [fromRoot('./packages/*/dist/**')],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 80,
        lines: 85,
      },
    },
  },
});

export default sharedVitestConfig;
