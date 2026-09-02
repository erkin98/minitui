import { fileURLToPath } from 'node:url';
import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../../vitest.shared.js';

const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const merged = mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: '@minitui/renderer-ink',
      environment: 'node',
      include: ['test/**/*.test.{ts,tsx}'],
      server: {
        deps: {
          // ink-testing-library ships with an unmet ink peer under pnpm, so when it is
          // externalized Node resolves its `ink` import by walking up to the workspace
          // root — a DIFFERENT ink (and react) than this package's pinned family, which
          // splits React in two and breaks every hook under the ink reconciler. Inlining
          // it routes its imports through the aliases below instead.
          inline: ['ink-testing-library'],
        },
      },
    },
  }),
);

// REPLACE (not merge) the shared react/ink aliases: vite's mergeConfig turns duplicate
// alias keys into an ordered list where the FIRST match wins, so a merged override would
// silently lose to the shared root alias. This package must test against ITS OWN pinned
// react/ink (the family @json-render/ink links against natively); the hoisted root copies
// can drift to a different react version, and a second React instance under the ink
// reconciler fails every hook call.
merged.resolve = {
  ...merged.resolve,
  alias: {
    react: local('./node_modules/react'),
    ink: local('./node_modules/ink'),
  },
};

export default merged;
