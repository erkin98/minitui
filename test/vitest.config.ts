import { defineProject, mergeConfig } from 'vitest/config';
import sharedVitestConfig from '../vitest.shared.js';

// One worker keeps the suites that share temporary directories and fake terminals from racing. The
// default isolation stays on: a project with isolation off and one worker cannot share a root run with
// projects at the default worker count.
export default mergeConfig(
  sharedVitestConfig,
  defineProject({
    test: {
      name: 'integration-tests',
      environment: 'node',
      maxWorkers: 1,
      include: ['e2e/**/*.test.ts', 'security/**/*.test.ts', 'conformance/**/*.test.ts'],
    },
  }),
);
