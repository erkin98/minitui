import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostOverExec,
  inTempDir,
  mergeAppWithState,
  passThroughSandbox,
} from './support/host-over-exec.js';

// The consent request is built from the app's live state, never from what the renderer resolved: the
// runtime host reads the live value of every root the action's templates name, and exec builds the
// request from those values. The renderer's parameters here point elsewhere, so a request that carried
// them would be visible.
describe('consent values come from live state, through the host and exec', () => {
  it('the request shows the live paths and codec, fills every hole, and a rejection runs nothing', async () => {
    await inTempDir(async (dir) => {
      const live = {
        inputs: [join(dir, 'first.mp4'), join(dir, 'second.mp4')],
        codec: 'copy',
        output: join(dir, 'joined.mp4'),
      };
      const app = await hostOverExec({
        spec: mergeAppWithState(live),
        mode: 'default',
        sandbox: passThroughSandbox(),
      });
      const requests = app.engine.requests[Symbol.asyncIterator]();
      const pending = app.pressMerge({
        inputs: ['/elsewhere/x.mp4', '/elsewhere/y.mp4'],
        codec: 'h264',
        output: '/elsewhere/z.mp4',
      });
      // The merge must stop at consent: an outcome before any request is a failure, not a wait.
      const first = await Promise.race([
        requests.next().then((next) => ({ next })),
        pending.then((outcome) => ({ outcome })),
      ]);
      if ('outcome' in first) {
        throw new Error(`the merge ended before consent: ${JSON.stringify(first.outcome)}`);
      }
      if (first.next.done === true) throw new Error('the engine surfaced no request');
      const request = first.next.value;

      expect(request.descriptor.summaryTemplate).toBe(
        `Merge the selected videos into ${live.output} using copy`,
      );
      expect(request.resolvedPaths).toEqual([...live.inputs, live.output]);
      expect(request.resolvedCommand).toContain(live.output);
      const shown = [
        request.descriptor.summaryTemplate,
        request.resolvedCommand,
        ...request.resolvedPaths,
      ].join('\n');
      expect(shown).not.toContain('${');
      expect(shown).not.toContain('/elsewhere');
      expect(shown).not.toContain('h264');

      app.engine.reply({ kind: 'reject', feedback: 'not now', requestId: request.id });
      expect(await pending).toMatchObject({ status: 'denied' });
      expect(app.runs).toHaveLength(0);
      app.session.dispose();
    });
  });
});
