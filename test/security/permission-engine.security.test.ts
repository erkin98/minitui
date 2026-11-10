import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hostOverExec,
  inTempDir,
  mergeAppWithState,
  passThroughSandbox,
} from './support/host-over-exec.js';

// The hard floor holds across the packages: a secret path that only the app's live state holds travels
// from the runtime host through the exec router and the request builder to the real engine, and the
// engine refuses it even in yolo mode. The renderer's own parameters are clean, so the refusal can only
// come from the live value the host reads.
describe('the hard floor through the host, the router and the engine', () => {
  it('a secret input held only in live state is refused in yolo mode and nothing runs', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const app = await hostOverExec({
        spec: mergeAppWithState({
          inputs: [join(dir, '.ssh', 'id_ed25519'), join(dir, 'b.mp4')],
          output,
        }),
        mode: 'yolo',
        sandbox: passThroughSandbox(),
      });
      const outcome = await app.pressMerge({
        inputs: [join(dir, 'a.mp4'), join(dir, 'b.mp4')],
        codec: 'copy',
        output,
      });
      expect(outcome).toMatchObject({
        status: 'denied',
        reason: expect.stringMatching(/protected secret/),
      });
      expect(app.runs).toHaveLength(0);
      app.session.dispose();
    });
  });

  // The control: the same press with clean inputs in live state passes the floor and stops at the planner
  // double, so the refusal above comes from the secret path the host read and nothing else.
  it('with clean inputs in live state the same press passes the floor', async () => {
    await inTempDir(async (dir) => {
      const output = join(dir, 'out.mp4');
      const inputs = [join(dir, 'a.mp4'), join(dir, 'b.mp4')];
      const app = await hostOverExec({
        spec: mergeAppWithState({ inputs, output }),
        mode: 'yolo',
        sandbox: passThroughSandbox(),
      });
      const outcome = await app.pressMerge({ inputs, codec: 'copy', output });
      expect(outcome).toMatchObject({
        status: 'failed',
        fault: { stderrExcerpt: 'the merge was planned' },
      });
      expect(app.runs).toHaveLength(0);
      app.session.dispose();
    });
  });
});
