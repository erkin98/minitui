import { describe, it, expect } from 'vitest';
import { createPermissionEngine } from '../../src/permission/index.js';
import type { PermissionReply, PermissionRequest } from '@minitui/types';

const NOT_CANONICAL =
  'request contains control or invisible characters and cannot be shown safely; rename the file or path and try again';
const TOO_LARGE = 'request too large to show for approval';
const UNRECOGNISED = 'reply not recognised: treated as a rejection';

let n = 0;
const request = (command: string, paths: string[] = []): PermissionRequest => ({
  id: `cb${n++}`,
  descriptor: { danger: false, resourceTemplate: command, summaryTemplate: 'merge clips' },
  resolvedCommand: command,
  resolvedPaths: paths,
});

describe('the consent boundary, end to end through the real engine', () => {
  it('a command that hides itself behind an escape sequence is denied, not asked', async () => {
    const e = await createPermissionEngine();
    const d = await e.check(request('ffmpeg -i a.mp4 out.mp4\x1b]0;ok\x07; rm -rf build'));
    expect(d).toEqual({ kind: 'deny', reason: NOT_CANONICAL });
  });

  it('a multi-line command is denied in YOLO mode too', async () => {
    const e = await createPermissionEngine({ mode: 'yolo' });
    const d = await e.check(request('ffmpeg -i a.mp4 out.mp4\nrm -rf build'));
    expect(d).toEqual({ kind: 'deny', reason: NOT_CANONICAL });
  });

  it('a request too large to show is denied, in either mode', async () => {
    for (const mode of ['default', 'yolo'] as const) {
      const e = await createPermissionEngine({ mode });
      const d = await e.check(request('ffmpeg -i ' + 'a'.repeat(5000)));
      expect(d).toEqual({ kind: 'deny', reason: TOO_LARGE });
    }
  });

  it('a reply of an unknown kind never approves', async () => {
    const e = await createPermissionEngine();
    const pending = e.check(request('ffmpeg -i a.mp4 out.mp4'));
    await e.requests[Symbol.asyncIterator]().next();
    const forged: PermissionReply = JSON.parse('{"kind":"deny","cascade":true}');
    e.reply(forged);
    expect(await pending).toEqual({ kind: 'deny', reason: UNRECOGNISED });
  });
});
