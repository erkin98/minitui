import { Text, render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { FakeStdin, FakeStdout, asReadStream, asWriteStream, waitFor } from '../src/index.js';

// The fake terminal leaves the package through the barrel, so a test elsewhere can hand the real ink
// renderer a stdin and a stdout and read what it drew.
describe('the exported fake terminal', () => {
  it('carries a real ink render, and waitFor sees the frame it drew', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const app = render(createElement(Text, null, 'drawn through the barrel'), {
      stdout: asWriteStream(stdout),
      stdin: asReadStream(stdin),
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await waitFor(
        () => stdout.frames.some((frame) => frame.includes('drawn through the barrel')),
        'the first frame',
      );
      expect(stdout.columns).toBe(100);
    } finally {
      app.unmount();
    }
  });
});
